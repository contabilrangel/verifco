import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  CircleCheck,
  ClipboardList,
  FileText,
  Mail,
  Megaphone,
  MessageCircle,
  Package,
  Paperclip,
  Receipt,
  Send,
  TrendingUp,
  Users,
} from 'lucide-react';
import { DECLARATION_STAGES, formatPhone, mailingTypeForTemplate, type MailingType, type MailingTypeKey } from '@verifco/shared';
import { Alert, Button, Card, Checkbox, ConfirmDialog, EmptyState, Loading, Select, Stat, Tag, cx, useToast } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi, useDebounced } from '../../lib/hooks';
import { stageLabel, stageTone } from '../../lib/format';
import { useYear } from '../../lib/year';
import { MailingRunCard, RecentMailings, type MailingRun } from './MailingRun';
import { MailPreview } from './TemplatesPage';
import './communication.css';

type Channel = 'email' | 'whatsapp' | 'both';
type Filters = { groups: string[]; noGroup: boolean; responsible: string[]; stage: string[]; email: '' | 'with' | 'without'; mobile: '' | 'with' | 'without' };
const EMPTY: Filters = { groups: [], noGroup: false, responsible: [], stage: [], email: '', mobile: '' };

interface PreviewResult {
  type: { key: MailingTypeKey; label: string; templateKey: string; note: string | null; attachment: 'kit' | 'checklist_pdf' | null };
  total: number;
  /** Clientes que atendem aos filtros; acima de `limit`, o envio é recusado. */
  matched: number;
  truncated: boolean;
  limit: number;
  withEmail: number;
  withoutEmail: number;
  withMobile: number;
  withoutMobile: number;
  customers: number;
  deliveries: { email: number; whatsapp: number; total: number };
  skipped: { reason: string; label: string; count: number; names: string[] }[];
  recipients: { id: string; name: string; email: string | null; mobile: string | null; channels: string[]; skips: string[]; stage: string }[];
  sample: null | {
    customerId: string;
    customerName: string;
    email: string | null;
    mobile: string | null;
    subject: string;
    html: string;
    text: string;
    attachment: string | null;
  };
}

const ICONS: Record<MailingTypeKey, ReactNode> = {
  checklist_digital: <ClipboardList />,
  checklist_pdf: <FileText />,
  planning: <TrendingUp />,
  marketing: <Megaphone />,
  monthly: <CalendarDays />,
  budget: <Receipt />,
  kit: <Package />,
};

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
const names = (list: string[], count: number) => (count > list.length ? `${list.join(', ')} e mais ${count - list.length}` : list.join(', '));

export function MailingPage() {
  const { can } = useAuth();
  const { year } = useYear();
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const ids = useMemo(() => (params.get('clientes') ?? '').split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x)), [params]);
  const initialType = useMemo<MailingTypeKey | ''>(() => {
    const tipo = params.get('tipo');
    if (tipo) return tipo as MailingTypeKey;
    const tpl = params.get('template');
    return tpl ? (mailingTypeForTemplate(tpl)?.key ?? '') : '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const types = useApi<(MailingType & { allowed: boolean })[]>(['mailing', 'types'], '/mailing/types');
  const [type, setType] = useState<MailingTypeKey | ''>(initialType);
  const [step, setStep] = useState<1 | 2 | 3>(initialType ? (ids.length ? 3 : 2) : 1);
  const [mode, setMode] = useState<'selected' | 'filters'>(ids.length ? 'selected' : 'filters');
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [channel, setChannel] = useState<Channel>('email');
  const [sampleId, setSampleId] = useState<string>('');
  const [confirm, setConfirm] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  /** Mala direta pedida (ou aberta em "Malas diretas recentes"): a tela mostra o andamento dela. */
  const [run, setRun] = useState<{ id: string; initial: MailingRun | null } | null>(null);

  const selected = types.data?.find((t) => t.key === type);
  // tipo vindo da URL sem permissão: volta para a escolha
  useEffect(() => {
    if (types.data && type && !types.data.find((t) => t.key === type)?.allowed) {
      setType('');
      setStep(1);
    }
  }, [types.data, type]);

  const body = useMemo(
    () => ({
      type,
      channel,
      year,
      ...(mode === 'selected' ? { customerIds: ids } : { filters: { ...filters, email: filters.email || undefined, mobile: filters.mobile || undefined } }),
      previewCustomerId: sampleId || undefined,
    }),
    [type, channel, year, mode, ids, filters, sampleId],
  );
  const debouncedBody = useDebounced(body, 250);
  const preview = useQuery<PreviewResult, ApiError>({
    queryKey: ['mailing', 'preview', debouncedBody],
    queryFn: () => api.post<PreviewResult>('/mailing/preview', debouncedBody),
    // usa o corpo já estabilizado (o tipo pode ter acabado de mudar)
    enabled: Boolean(type) && debouncedBody.type === type && step >= 2 && !run,
    placeholderData: (prev) => prev,
  });
  const p = preview.data;

  const send = useAction(() => api.post<MailingRun>('/mailing/send', { ...body, previewCustomerId: undefined, requestId }), {
    invalidate: [['deliveries'], ['mailing', 'runs']],
    onSuccess: (r) => {
      setConfirm(false);
      setRun({ id: r.id, initial: r });
    },
  });

  const restart = () => {
    setRun(null);
    setRequestId(crypto.randomUUID());
    setStep(1);
    setType('');
    setSampleId('');
    setParams({});
    setMode('filters');
  };

  const steps = [
    { n: 1, label: 'Tipo de envio' },
    { n: 2, label: 'Destinatários' },
    { n: 3, label: 'Canal e revisão' },
  ] as const;

  return (
    <>
      <PageHeader
        title="Mala direta"
        description={`Envie comunicados, checklists, orçamentos e o kit pós-declaração para vários clientes de uma vez. Exercício ${year}.`}
        crumbs={[{ label: 'Início', to: '/' }, { label: 'Comunicação' }, { label: 'Mala direta' }]}
      />
      {run ? (
        <MailingRunCard
          id={run.id}
          initial={run.initial}
          actions={
            <>
              {can('mailing.list') && <Button onClick={() => navigate('/comunicacao/envios')}>Ver os e-mails enviados</Button>}
              <Button kind="secondary" onClick={restart}>
                Nova mala direta
              </Button>
            </>
          }
        />
      ) : (
        <>
          <nav className="vf-wizard-steps" aria-label="Etapas">
            {steps.map((s) => (
              <button
                key={s.n}
                type="button"
                className={cx('vf-step', step === s.n && 'active')}
                disabled={s.n > 1 && !type}
                onClick={() => setStep(s.n)}
                aria-current={step === s.n ? 'step' : undefined}
              >
                <span className="vf-step__n">{step > s.n ? <Check size={14} /> : s.n}</span>
                {s.label}
              </button>
            ))}
          </nav>

          {step === 1 && (
            <Card title="Qual envio você quer fazer?">
              {types.isLoading ? (
                <Loading />
              ) : (
                <div className="vf-choice-grid">
                  {types.data?.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      className="vf-choice"
                      aria-pressed={type === t.key}
                      disabled={!t.allowed}
                      title={t.allowed ? undefined : 'Seu perfil não tem permissão para este envio.'}
                      onClick={() => {
                        setType(t.key);
                        setSampleId('');
                      }}
                    >
                      {type === t.key && <CircleCheck className="vf-choice__check" size={20} />}
                      <span className="vf-choice__icon">{ICONS[t.key]}</span>
                      <span className="vf-choice__title">{t.label}</span>
                      <span className="vf-choice__desc">{t.description}</span>
                      <span className="vf-inline" style={{ '--gap': '4px' } as React.CSSProperties}>
                        {t.attachment && (
                          <Tag icon={<Paperclip size={12} />} tone="primary">
                            PDF anexo
                          </Tag>
                        )}
                        {!t.allowed && <Tag>Sem permissão</Tag>}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div className="vf-inline vf-between" style={{ marginTop: 24 }}>
                <span className="vf-text-xs vf-muted">
                  O texto de cada envio vem dos <Link to="/comunicacao/templates">templates de e-mail</Link>.
                </span>
                <Button icon={<ArrowRight />} disabled={!type} onClick={() => setStep(ids.length && mode === 'selected' ? 3 : 2)}>
                  Continuar
                </Button>
              </div>
            </Card>
          )}
          {step === 1 && (
            <div style={{ marginTop: 24 }}>
              <RecentMailings onOpen={(id) => setRun({ id, initial: null })} />
            </div>
          )}

          {step === 2 && type && (
            <RecipientsStep
              year={year}
              ids={ids}
              mode={mode}
              setMode={setMode}
              filters={filters}
              setFilters={setFilters}
              preview={p}
              loading={preview.isFetching}
              onBack={() => setStep(1)}
              onNext={() => setStep(3)}
            />
          )}

          {step === 3 && type && (
            <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>
              <Card title="Canal">
                <div className="vf-choice-grid">
                  {(
                    [
                      ['email', 'E-mail', <Mail key="m" />, 'Para quem tem e-mail cadastrado.'],
                      ['whatsapp', 'WhatsApp', <MessageCircle key="w" />, 'Para quem tem celular cadastrado.'],
                      ['both', 'E-mail e WhatsApp', <Send key="b" />, 'Cada canal vai para quem tiver o contato.'],
                    ] as [Channel, string, ReactNode, string][]
                  ).map(([v, label, icon, desc]) => (
                    <button key={v} type="button" className="vf-choice" aria-pressed={channel === v} onClick={() => setChannel(v)}>
                      {channel === v && <CircleCheck className="vf-choice__check" size={20} />}
                      <span className="vf-choice__icon">{icon}</span>
                      <span className="vf-choice__title">{label}</span>
                      <span className="vf-choice__desc">{desc}</span>
                    </button>
                  ))}
                </div>
              </Card>

              {!p ? (
                preview.error ? (
                  <Alert tone="danger">{preview.error.message}</Alert>
                ) : (
                  <Loading label="Calculando os destinatários..." />
                )
              ) : (
                <>
                  <Card title="Revisão">
                    <div className="vf-stack">
                      <div className="vf-grid" style={{ '--cols': 4 } as React.CSSProperties}>
                        <Stat label="Clientes selecionados" value={p.total} />
                        <Stat label="Vão receber" value={p.customers} tone={p.customers ? 'success' : 'danger'} />
                        <Stat label="E-mails" value={p.deliveries.email} hint={`${p.withoutEmail} cliente(s) sem e-mail`} />
                        <Stat label="WhatsApp" value={p.deliveries.whatsapp} hint={`${p.withoutMobile} cliente(s) sem celular`} />
                      </div>
                      {p.truncated && (
                        <Alert tone="danger" title={`${p.matched.toLocaleString('pt-BR')} clientes atendem aos filtros`}>
                          Cada mala direta vai para até {p.limit.toLocaleString('pt-BR')} clientes. Volte aos destinatários e use os filtros (grupo, responsável, etapa) para dividir o envio.
                        </Alert>
                      )}
                      {p.type.note && <Alert>{p.type.note}</Alert>}
                      {p.skipped.length > 0 && (
                        <Alert tone="warning" title={`${p.skipped.reduce((a, s) => a + s.count, 0)} situação(ões) sem envio`}>
                          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                            {p.skipped.map((s) => (
                              <li key={s.reason}>
                                <strong>
                                  {s.count} — {s.label.toLowerCase()}
                                </strong>
                                : {names(s.names, s.count)}
                              </li>
                            ))}
                          </ul>
                        </Alert>
                      )}
                    </div>
                  </Card>

                  <Card
                    title="Pré-visualização"
                    actions={
                      p.recipients.length > 0 && (
                        <div style={{ width: 280 }}>
                          <Select
                            aria-label="Pré-visualizar para"
                            value={p.sample?.customerId ?? ''}
                            onChange={(e) => setSampleId(e.target.value)}
                            options={p.recipients.map((r) => ({ value: r.id, label: r.name }))}
                          />
                        </div>
                      )
                    }
                  >
                    {!p.sample ? (
                      <EmptyState icon={<Users />} title="Nenhum cliente selecionado" description="Volte e escolha os destinatários." />
                    ) : (
                      <div className="vf-stack">
                        {p.sample.attachment && (
                          <div className="vf-inline">
                            <Tag tone="primary" icon={<Paperclip size={12} />}>
                              {p.sample.attachment}
                            </Tag>
                            <Button
                              size="sm"
                              kind="tertiary"
                              onClick={() => void api.open(`/mailing/attachment-preview?type=${p.type.attachment}&customerId=${p.sample!.customerId}&year=${year}`).catch((e: Error) => toast.error(e.message))}
                            >
                              Abrir o anexo deste cliente
                            </Button>
                          </div>
                        )}
                        {channel !== 'whatsapp' && (
                          <>
                            {!p.sample.email && <Alert tone="warning">{p.sample.customerName} não tem e-mail cadastrado e não receberá por e-mail.</Alert>}
                            <MailPreview subject={p.sample.subject} html={p.sample.html} to={p.sample.email ?? '—'} />
                          </>
                        )}
                        {channel !== 'email' && (
                          <div className="vf-wa-preview">
                            <div className="vf-text-xs vf-muted" style={{ marginBottom: 8 }}>
                              {p.sample.mobile ? `WhatsApp para ${formatPhone(p.sample.mobile)}` : `${p.sample.customerName} não tem celular cadastrado e não receberá pelo WhatsApp.`}
                            </div>
                            <div className="vf-bubble vf-bubble--other">{p.sample.text}</div>
                          </div>
                        )}
                      </div>
                    )}
                  </Card>
                </>
              )}

              <div className="vf-inline vf-between">
                <Button kind="secondary" icon={<ArrowLeft />} onClick={() => setStep(2)}>
                  Destinatários
                </Button>
                <Button icon={<Send />} disabled={!p || !p.customers || p.truncated || preview.isFetching} onClick={() => setConfirm(true)}>
                  Enviar para {p?.customers ?? 0} cliente(s)
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirm}
        title="Confirmar envio"
        confirmLabel="Enviar agora"
        loading={send.isPending}
        onConfirm={() => send.mutate(undefined)}
        onClose={() => setConfirm(false)}
        message={
          p && (
            <div className="vf-stack" style={{ '--gap': '8px' } as React.CSSProperties}>
              <span>
                <strong>{selected?.label}</strong> para <strong>{p.customers}</strong> cliente(s): {p.deliveries.email} e-mail(s) e {p.deliveries.whatsapp} WhatsApp.
              </span>
              {p.total - p.customers > 0 && <span>{p.total - p.customers} cliente(s) ficarão de fora por falta de contato ou de dados.</span>}
              <span>O envio vai para a fila e você acompanha o andamento nesta tela.</span>
            </div>
          )
        }
      />
    </>
  );
}

function RecipientsStep({
  year,
  ids,
  mode,
  setMode,
  filters,
  setFilters,
  preview,
  loading,
  onBack,
  onNext,
}: {
  year: number;
  ids: string[];
  mode: 'selected' | 'filters';
  setMode: (m: 'selected' | 'filters') => void;
  filters: Filters;
  setFilters: (f: Filters) => void;
  preview: PreviewResult | undefined;
  loading: boolean;
  onBack: () => void;
  onNext: () => void;
}) {
  const groups = useApi<{ id: string; name: string }[]>(['customer-groups'], mode === 'filters' ? '/customer-groups' : null);
  const employees = useApi<{ id: string; name: string }[]>(['employees'], mode === 'filters' ? '/employees' : null);
  const set = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch });
  return (
    <div className={cx('vf-two-col', mode === 'filters' ? 'vf-two-col--filters' : 'vf-two-col--single')}>
      {mode === 'filters' && (
        <Card title="Filtros">
          <div className="vf-stack" style={{ '--gap': '20px' } as React.CSSProperties}>
            <FilterGroup title={`Declaração ${year}`}>
              {Object.keys(DECLARATION_STAGES).map((s) => (
                <Checkbox key={s} label={stageLabel(s)} checked={filters.stage.includes(s)} onChange={() => set({ stage: toggle(filters.stage, s) })} />
              ))}
            </FilterGroup>
            <FilterGroup title="Contato">
              <Checkbox label="Com e-mail" checked={filters.email === 'with'} onChange={() => set({ email: filters.email === 'with' ? '' : 'with' })} />
              <Checkbox label="Sem e-mail" checked={filters.email === 'without'} onChange={() => set({ email: filters.email === 'without' ? '' : 'without' })} />
              <Checkbox label="Com celular" checked={filters.mobile === 'with'} onChange={() => set({ mobile: filters.mobile === 'with' ? '' : 'with' })} />
              <Checkbox label="Sem celular" checked={filters.mobile === 'without'} onChange={() => set({ mobile: filters.mobile === 'without' ? '' : 'without' })} />
            </FilterGroup>
            <FilterGroup title="Grupos">
              <Checkbox label="Sem grupo" checked={filters.noGroup} onChange={() => set({ noGroup: !filters.noGroup })} />
              {(groups.data ?? []).map((g) => (
                <Checkbox key={g.id} label={g.name} checked={filters.groups.includes(g.id)} onChange={() => set({ groups: toggle(filters.groups, g.id) })} />
              ))}
            </FilterGroup>
            {(employees.data?.length ?? 0) > 0 && (
              <FilterGroup title="Responsável">
                {employees.data!.map((u) => (
                  <Checkbox key={u.id} label={u.name} checked={filters.responsible.includes(u.id)} onChange={() => set({ responsible: toggle(filters.responsible, u.id) })} />
                ))}
              </FilterGroup>
            )}
            <Button kind="tertiary" size="sm" onClick={() => setFilters(EMPTY)}>
              Limpar filtros
            </Button>
          </div>
        </Card>
      )}
      <Card
        flush
        title={
          <span className="vf-inline">
            {preview ? `${preview.total} cliente(s)` : 'Destinatários'}
            {loading && <span className="vf-spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />}
          </span>
        }
        actions={
          ids.length > 0 && (
            <Button size="sm" kind="tertiary" onClick={() => setMode(mode === 'selected' ? 'filters' : 'selected')}>
              {mode === 'selected' ? 'Escolher por filtros' : `Usar os ${ids.length} selecionados na lista`}
            </Button>
          )
        }
      >
        <div style={{ padding: '0 24px 12px' }} className="vf-text-xs vf-muted">
          {mode === 'selected' ? `Clientes escolhidos na lista de clientes (${ids.length}).` : 'Clientes ativos que atendem aos filtros. Sem filtros, todos os clientes ativos.'}
        </div>
        {!preview ? (
          <Loading />
        ) : preview.recipients.length === 0 ? (
          <EmptyState icon={<Users />} title="Nenhum cliente encontrado" description="Ajuste os filtros para escolher os destinatários." />
        ) : (
          <div className="vf-table-wrap" style={{ maxHeight: 480, overflowY: 'auto' }}>
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>E-mail</th>
                  <th>Celular</th>
                  <th>Declaração {year}</th>
                </tr>
              </thead>
              <tbody>
                {preview.recipients.map((r) => (
                  <tr key={r.id}>
                    <td className="vf-text-sm-bold">{r.name}</td>
                    <td>{r.email || <Tag tone="warning">Sem e-mail</Tag>}</td>
                    <td>{r.mobile ? formatPhone(r.mobile) : <Tag tone="warning">Sem celular</Tag>}</td>
                    <td>
                      <Tag tone={stageTone(r.stage)}>{stageLabel(r.stage)}</Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.total > preview.recipients.length && <div className="vf-text-xs vf-muted" style={{ padding: 16 }}>Mostrando {preview.recipients.length} de {preview.total}.</div>}
            {preview.truncated && (
              <div style={{ padding: '0 16px 16px' }}>
                <Alert tone="danger">
                  {preview.matched.toLocaleString('pt-BR')} clientes atendem aos filtros; cada mala direta vai para até {preview.limit.toLocaleString('pt-BR')}. Use os filtros para dividir o envio.
                </Alert>
              </div>
            )}
          </div>
        )}
        <div className="vf-inline vf-between" style={{ padding: 16, borderTop: '1px solid var(--color-border)' }}>
          <Button kind="secondary" icon={<ArrowLeft />} onClick={onBack}>
            Tipo de envio
          </Button>
          <Button icon={<ArrowRight />} disabled={!preview?.total} onClick={onNext}>
            Continuar
          </Button>
        </div>
      </Card>
    </div>
  );
}

function FilterGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="vf-text-sm-bold" style={{ marginBottom: 8 }}>
        {title}
      </legend>
      <div className="vf-stack" style={{ '--gap': '8px' } as React.CSSProperties}>
        {children}
      </div>
    </fieldset>
  );
}
