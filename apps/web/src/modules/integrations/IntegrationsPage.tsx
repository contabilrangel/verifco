import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import {
  Banknote,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Landmark,
  Mail,
  MessageCircle,
  PlugZap,
  Receipt,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import {
  INTEGRATION_CATALOG,
  INTEGRATION_CATEGORIES,
  INTEGRATION_STATUS,
  activeIntegrationFields,
  formatCpfCnpj,
  integrationConditionMet,
  type IntegrationDef,
  type IntegrationField,
  type IntegrationStatus,
} from '@verifco/shared';
import { Alert, Button, Card, Checkbox, ConfirmDialog, IconButton, Input, Loading, Select, Switch, Tag, cx, useToast, type Tone } from '../../ds';
import { api } from '../../lib/api';
import { fieldErrors, useAction, useApi } from '../../lib/hooks';
import { formatDateTime } from '../../lib/format';

export interface IntegrationView {
  provider: string;
  label: string;
  saved: boolean;
  enabled: boolean;
  status: IntegrationStatus;
  lastError: string | null;
  lastTestAt: string | null;
  updatedAt: string | null;
  config: Record<string, unknown>;
  secrets: Record<string, { configured: boolean; last4: string | null }>;
  missing: string[];
  webhookUrl: string | null;
  platformFallback: boolean;
}

interface Certificate {
  id: string;
  name: string;
  cpfCnpj: string;
  hasCertificate: boolean;
  certificateExpiresAt: string | null;
}

const ICONS: Record<string, LucideIcon> = {
  asaas: Banknote,
  omie: Receipt,
  smtp: Mail,
  whatsapp: MessageCircle,
  serpro: Landmark,
  ai: Sparkles,
};

const STATUS_TONE: Record<IntegrationStatus, Tone> = {
  not_configured: 'neutral',
  configured: 'primary',
  connected: 'success',
  error: 'danger',
};

/** Integrações que aceitam um destino para a mensagem de teste. */
const SEND_TEST: Record<string, { label: string; placeholder: string }> = {
  smtp: { label: 'Enviar e-mail de teste para', placeholder: 'voce@escritorio.com.br' },
  whatsapp: { label: 'Enviar mensagem de teste para', placeholder: '55 11 98765-4321' },
};

const KEY = ['integrations'];

export function IntegrationsPage() {
  const list = useApi<IntegrationView[]>(KEY, '/integrations');
  if (list.isLoading) return <Loading />;
  if (list.error || !list.data) return <Alert tone="danger" title="Não foi possível carregar as integrações." />;
  const byProvider = new Map(list.data.map((v) => [v.provider, v]));
  const categories = Object.keys(INTEGRATION_CATEGORIES) as (keyof typeof INTEGRATION_CATEGORIES)[];
  return (
    <div className="vf-stack" style={{ '--gap': '32px' } as CSSProperties}>
      <Alert tone="primary" title="Credenciais protegidas">
        Chaves, tokens e senhas ficam cifrados no servidor e nunca voltam ao navegador: depois de salvos, aparecem só os 4 últimos caracteres. Cada escritório
        configura as próprias contas.
      </Alert>
      {categories.map((cat) => {
        const defs = INTEGRATION_CATALOG.filter((d) => d.category === cat);
        if (!defs.length) return null;
        return (
          <section key={cat} className="vf-stack" style={{ '--gap': '12px' } as CSSProperties} aria-labelledby={`int-cat-${cat}`}>
            <h2 id={`int-cat-${cat}`} className="vf-text-md-bold">
              {INTEGRATION_CATEGORIES[cat]}
            </h2>
            {defs.map((def) => {
              const view = byProvider.get(def.key);
              return view ? <IntegrationCard key={def.key} def={def} view={view} /> : null;
            })}
          </section>
        );
      })}
    </div>
  );
}

type FormValues = Record<string, string | number | boolean>;

function toForm(def: IntegrationDef, view: IntegrationView): FormValues {
  const out: FormValues = {};
  for (const f of def.fields) {
    if (f.type === 'secret') out[f.key] = '';
    else {
      const v = view.config[f.key] ?? f.default;
      out[f.key] = f.type === 'boolean' ? Boolean(v) : v === undefined || v === null ? '' : (v as string | number);
    }
  }
  return out;
}

function IntegrationCard({ def, view }: { def: IntegrationDef; view: IntegrationView }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormValues>(() => toForm(def, view));
  const [sendTo, setSendTo] = useState('');
  const [confirm, setConfirm] = useState<null | 'delete' | 'token'>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => setForm(toForm(def, view)), [def, view]);

  const Icon = ICONS[def.key] ?? PlugZap;
  const fields = activeIntegrationFields(def, form);
  const steps = def.steps.filter((s) => integrationConditionMet(s.when, form));
  const initial = useMemo(() => toForm(def, view), [def, view]);
  const dirty = def.fields.some((f) => (f.type === 'secret' ? Boolean(form[f.key]) : form[f.key] !== initial[f.key]));
  const needsCertificates = def.fields.some((f) => f.type === 'procurator');
  const certificates = useApi<Certificate[]>(['integrations', 'serpro-certificates'], needsCertificates && open ? '/integrations/serpro/certificates' : null);

  const payload = () => {
    const config: Record<string, unknown> = {};
    const secrets: Record<string, string> = {};
    for (const f of fields) {
      if (f.type === 'secret') {
        const v = String(form[f.key] ?? '').trim();
        if (v) secrets[f.key] = v;
      } else config[f.key] = form[f.key];
    }
    return { config, secrets };
  };

  const save = useAction(() => api.put<IntegrationView>(`/integrations/${def.key}`, payload()), { success: `${def.label}: configuração salva.`, invalidate: [KEY] });
  const toggle = useAction((enabled: boolean) => api.put<IntegrationView>(`/integrations/${def.key}`, { enabled }), {
    success: (r) => (r.enabled ? `${def.label} ativada.` : `${def.label} desativada.`),
    invalidate: [KEY],
  });
  const test = useAction(
    async () => {
      if (dirty) await api.put(`/integrations/${def.key}`, payload());
      return api.post<{ ok: boolean; message: string }>(`/integrations/${def.key}/test`, { sendTo: sendTo || undefined });
    },
    {
      invalidate: [KEY],
      onSuccess: (r) => {
        setTestResult(r);
        if (r.ok) toast.success(r.message);
        else toast.error(r.message);
      },
    },
  );
  const remove = useAction(() => api.del(`/integrations/${def.key}`), {
    success: `${def.label}: integração removida.`,
    invalidate: [KEY],
    onSuccess: () => {
      setConfirm(null);
      setTestResult(null);
    },
  });
  const rotate = useAction(() => api.post<IntegrationView>(`/integrations/${def.key}/webhook-token`), {
    success: 'Nova URL gerada. Atualize o webhook no provedor.',
    invalidate: [KEY],
    onSuccess: () => setConfirm(null),
  });
  const errors = fieldErrors(save.error ?? test.error);

  const set = (key: string, value: string | number | boolean) => setForm((f) => ({ ...f, [key]: value }));

  const copyWebhook = async () => {
    if (!view.webhookUrl) return;
    try {
      await navigator.clipboard.writeText(view.webhookUrl);
      toast.success('URL do webhook copiada.');
    } catch {
      toast.error('Não foi possível copiar. Selecione o texto e copie manualmente.');
    }
  };

  return (
    <Card className={cx('vf-int-card', open && 'vf-int-card--open')}>
      <div className="vf-int-head">
        <span className={cx('vf-int-icon', `vf-int-icon--${def.category}`)} aria-hidden>
          <Icon />
        </span>
        <div className="vf-grow vf-stack" style={{ '--gap': '6px' } as CSSProperties}>
          <div className="vf-inline" style={{ '--gap': '8px' } as CSSProperties}>
            <h3 className="vf-text-md-bold">{def.label}</h3>
            <StatusTags view={view} />
          </div>
          <p className="vf-muted">{def.description}</p>
          {view.lastTestAt && (
            <span className="vf-text-xs vf-muted">
              Último teste em {formatDateTime(view.lastTestAt)}
              {view.status === 'connected' ? ': conexão funcionando.' : view.status === 'error' ? ': falhou.' : '.'}
            </span>
          )}
          {!open && view.status === 'error' && view.lastError && <span className="vf-text-xs vf-danger-text">{view.lastError}</span>}
        </div>
        <div className="vf-inline vf-int-actions">
          {view.saved && (
            <Switch label={view.enabled ? 'Ativa' : 'Inativa'} checked={view.enabled} disabled={toggle.isPending} onChange={(v) => toggle.mutate(v)} />
          )}
          <Button kind="secondary" size="sm" icon={open ? <ChevronUp /> : <ChevronDown />} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'Fechar' : view.saved ? 'Configurar' : 'Conectar'}
          </Button>
        </div>
      </div>

      {open && (
        <>
          <div className="vf-int-body">
            <div className="vf-stack" style={{ '--gap': '20px' } as CSSProperties}>
              {view.status === 'error' && view.lastError && (
                <Alert tone="danger" title="Último teste falhou">
                  {view.lastError}
                </Alert>
              )}
              {testResult?.ok && <Alert tone="success">{testResult.message}</Alert>}
              {view.platformFallback && !view.enabled && (
                <Alert tone="primary">
                  {def.key === 'smtp'
                    ? 'Enquanto o SMTP do escritório não estiver ativo, os e-mails saem pelo envio padrão do Verifco.'
                    : 'Enquanto o escritório não tiver chave própria ativa, a IA usa a chave da plataforma.'}
                </Alert>
              )}
              <div className="vf-int-fields">
                {fields.map((f) => (
                  <FieldInput
                    key={f.key}
                    field={f}
                    value={form[f.key]}
                    secret={view.secrets[f.key]}
                    error={errors[`config.${f.key}`]}
                    certificates={certificates.data}
                    onChange={(v) => set(f.key, v)}
                  />
                ))}
              </div>
              {def.webhook && (
                <div className="vf-stack" style={{ '--gap': '6px' } as CSSProperties}>
                  <span className="vf-field__label">URL do webhook</span>
                  {view.webhookUrl ? (
                    <>
                      <div className="vf-inline" style={{ flexWrap: 'nowrap' }}>
                        <code className="vf-int-code" title={view.webhookUrl}>
                          {view.webhookUrl}
                        </code>
                        <IconButton label="Copiar URL" onClick={copyWebhook}>
                          <Copy />
                        </IconButton>
                        <IconButton label="Gerar nova URL" onClick={() => setConfirm('token')}>
                          <RefreshCw />
                        </IconButton>
                      </div>
                      <span className="vf-field__help">
                        Cadastre esta URL no webhook de cobranças do {def.label}. Ela é exclusiva do seu escritório; trate-a como uma senha.
                      </span>
                    </>
                  ) : (
                    <span className="vf-field__help">Salve a configuração para gerar a URL exclusiva do escritório.</span>
                  )}
                </div>
              )}
            </div>
            <aside className="vf-int-aside" aria-label={`Como configurar ${def.label}`}>
              <span className="vf-text-sm-bold">Como configurar</span>
              <ol className="vf-int-steps">
                {steps.map((s) => (
                  <li key={s.text}>{s.text}</li>
                ))}
              </ol>
              <span className="vf-text-sm-bold" style={{ marginTop: 8 }}>
                O que a integração faz
              </span>
              <ul className="vf-int-steps vf-int-steps--check">
                {def.capabilities.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <a className="vf-inline vf-text-xs" href={def.docsUrl} target="_blank" rel="noreferrer noopener" style={{ '--gap': '4px', marginTop: 4 } as CSSProperties}>
                Documentação oficial <ExternalLink size={14} />
              </a>
            </aside>
          </div>
          <div className="vf-int-foot">
            <div className="vf-inline">
              {view.saved && (
                <Button kind="tertiary" size="sm" icon={<Trash2 />} onClick={() => setConfirm('delete')} className="vf-int-danger">
                  Remover
                </Button>
              )}
              <span className="vf-inline vf-text-xs vf-muted" style={{ '--gap': '4px' } as CSSProperties}>
                <ShieldCheck size={14} /> Segredos em branco mantêm o valor salvo.
              </span>
            </div>
            <div className="vf-inline" style={{ '--gap': '12px', alignItems: 'flex-end' } as CSSProperties}>
              {SEND_TEST[def.key] && (
                <Input
                  aria-label={SEND_TEST[def.key].label}
                  placeholder={`${SEND_TEST[def.key].label}…`}
                  value={sendTo}
                  onChange={(e) => setSendTo(e.target.value)}
                  style={{ width: 280 }}
                  title="Opcional: além de conferir a conexão, envia uma mensagem real"
                />
              )}
              <Button
                kind="secondary"
                icon={<PlugZap />}
                loading={test.isPending}
                disabled={!view.saved && !dirty && !(def.key === 'ai' && view.platformFallback)}
                onClick={() => test.mutate(undefined)}
              >
                {dirty ? 'Salvar e testar' : 'Testar conexão'}
              </Button>
              <Button icon={<Save />} loading={save.isPending} disabled={!dirty} onClick={() => save.mutate(undefined)}>
                Salvar
              </Button>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirm === 'delete'}
        title={`Remover a integração ${def.label}?`}
        message="A configuração e as credenciais salvas serão apagadas. Cobranças e envios já feitos não são afetados."
        confirmLabel="Remover"
        danger
        loading={remove.isPending}
        onConfirm={() => remove.mutate(undefined)}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'token'}
        title="Gerar nova URL do webhook?"
        message={`A URL atual deixa de funcionar na hora. Atualize o webhook no ${def.label} com a nova URL logo em seguida.`}
        confirmLabel="Gerar nova URL"
        loading={rotate.isPending}
        onConfirm={() => rotate.mutate(undefined)}
        onClose={() => setConfirm(null)}
      />
    </Card>
  );
}

function StatusTags({ view }: { view: IntegrationView }) {
  if (!view.saved) {
    return view.platformFallback ? <Tag tone="highlight">Usando o padrão do Verifco</Tag> : <Tag>{INTEGRATION_STATUS.not_configured}</Tag>;
  }
  return (
    <>
      <Tag tone={STATUS_TONE[view.status] ?? 'neutral'}>{INTEGRATION_STATUS[view.status] ?? view.status}</Tag>
      {!view.enabled && <Tag>Desativada</Tag>}
    </>
  );
}

function FieldInput({
  field: f,
  value,
  secret,
  error,
  certificates,
  onChange,
}: {
  field: IntegrationField;
  value: string | number | boolean | undefined;
  secret?: { configured: boolean; last4: string | null };
  error?: string;
  certificates?: Certificate[];
  onChange: (v: string | number | boolean) => void;
}) {
  const style = f.wide || f.type === 'boolean' ? { gridColumn: '1 / -1' } : undefined;
  if (f.type === 'boolean') {
    return (
      <div style={style}>
        <Checkbox label={f.label} checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
      </div>
    );
  }
  if (f.type === 'select') {
    return <Select label={f.label} required={f.required} help={f.help} error={error} options={f.options ?? []} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} style={style} />;
  }
  if (f.type === 'procurator') {
    const usable = (certificates ?? []).filter((c) => c.hasCertificate);
    return (
      <Select
        label={f.label}
        required={f.required}
        error={error}
        placeholder={usable.length ? 'Selecione' : 'Nenhum certificado cadastrado'}
        options={usable.map((c) => ({
          value: c.id,
          label: `${c.name} – ${formatCpfCnpj(c.cpfCnpj)}${c.certificateExpiresAt ? ` (vence em ${c.certificateExpiresAt.split('-').reverse().join('/')})` : ''}`,
        }))}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        help={
          certificates && !usable.length ? (
            <>
              Cadastre o certificado A1 em <Link to="/admin/procuradores">Administração › Procuradores</Link>.
            </>
          ) : (
            f.help
          )
        }
        style={style}
      />
    );
  }
  if (f.type === 'secret') {
    const configured = secret?.configured;
    return (
      <Input
        label={f.label}
        type="password"
        autoComplete="new-password"
        required={f.required && !configured}
        error={error}
        placeholder={configured ? `•••••••• ${secret?.last4 ?? ''}`.trim() : f.placeholder}
        help={configured ? `Configurado${secret?.last4 ? `, termina em ${secret.last4}` : ''}. Deixe em branco para manter.` : f.help}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        style={style}
      />
    );
  }
  return (
    <Input
      label={f.label}
      type={f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : f.type === 'url' ? 'url' : 'text'}
      required={f.required}
      placeholder={f.placeholder}
      help={f.help}
      error={error}
      value={value === undefined || value === null ? '' : String(value)}
      onChange={(e) => onChange(f.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)}
      style={style}
    />
  );
}
