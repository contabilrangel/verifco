/**
 * Páginas de operação do painel do sistema: fila de tarefas e e-mail, configurações globais,
 * a conta de quem está logado e a ficha de um escritório. As demais ficam em PlatformPanel.tsx.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Ban, CheckCircle2, RefreshCw, Send, Trash2, TriangleAlert } from 'lucide-react';
import { CONTRACT_STATUS, formatCpfCnpj, formatDateTimeBr } from '@verifco/shared';
import { Alert, Button, Card, Input, Loading, PasswordInput, Select, Tag, Textarea } from '../../ds';
import { errorMessage } from '../../lib/api';
import { TwoFactorCard } from '../../app/TwoFactorCard';
import { platformRequest as request, savePlatformToken } from './client';

export type PageProps = {
  owner: boolean;
  revision: number;
  busy: boolean;
  action: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
  confirm: (title: string, fn: () => Promise<unknown>, message?: string) => void;
};

export function useData<T>(path: string | null, revision = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setError('');
    if (path === null) {
      setData(undefined);
      return;
    }
    request<T>(path)
      .then((d) => {
        if (live) setData(d);
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [path, revision]);
  return { data, error };
}

export function DataState({ error, loading, children }: { error: string; loading: boolean; children: ReactNode }) {
  return error ? <Alert tone="danger" title={error} /> : loading ? <Loading /> : <>{children}</>;
}

const dateBr = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');
const when = (iso: string | null | undefined) => (iso ? formatDateTimeBr(iso) : 'nunca');

export function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
  return `${Math.max(bytes ? 1 : 0, Math.round(bytes / 1024))} KB`;
}

/** "há 3 min", "há 2 h": idade da tarefa mais antiga parada na fila. */
export function ageLabel(seconds: number | null | undefined) {
  if (!seconds || seconds < 60) return 'menos de 1 min';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} dia(s)`;
}

// ---------------------------------------------------------------- visão geral
export interface OverviewData {
  offices: number;
  blocked_offices: number;
  collaborators: number;
  active_contracts: number;
  queued_jobs: number;
  running_jobs: number;
  failed_jobs: number;
  failed_jobs_24h: number;
  oldest_queued_seconds: number | null;
  queue: { worker: boolean; alive: boolean; lastTickAt: string | null };
  email: boolean;
}

/** Avisos do que pede atenção agora: fila parada, falhas recentes, e-mail do sistema ausente. */
export function HealthAlerts({ data }: { data: OverviewData }) {
  const stuck = (data.oldest_queued_seconds ?? 0) > 600;
  return (
    <>
      {data.queue.worker && !data.queue.alive && (
        <Alert tone="danger" title="A fila de tarefas parou de responder">
          O processo que executa as tarefas não dá sinal há mais de um minuto. Envios, sincronizações e backups ficam parados até ele voltar: veja os registros do serviço e reinicie se for preciso.
        </Alert>
      )}
      {stuck && (
        <Alert tone="warning" title={`Há tarefas esperando há ${ageLabel(data.oldest_queued_seconds)}`}>
          {data.queue.worker ? 'A fila está andando devagar ou travada.' : 'Este servidor só atende a API: confira se o serviço que executa as tarefas (worker) está no ar.'}
        </Alert>
      )}
      {data.failed_jobs_24h > 0 && (
        <Alert tone="warning" title={`${data.failed_jobs_24h} tarefa(s) falharam nas últimas 24 horas`}>
          Veja o motivo e tente de novo em Operação.
        </Alert>
      )}
      {!data.email && (
        <Alert tone="warning" title="O e-mail do sistema não está configurado">
          Convites e redefinições de senha só saem pelos escritórios que configuraram o próprio e-mail. Defina SMTP_URL no servidor e teste em Operação.
        </Alert>
      )}
    </>
  );
}

// ---------------------------------------------------------------- operação
interface Job {
  id: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  officeName: string | null;
  createdAt: string;
  finishedAt: string | null;
}
interface EmailInfo {
  configured: boolean;
  host: string | null;
  port: number | null;
  secure: boolean | null;
  from: string;
  required: boolean;
  accountMailFailures7d: number;
  deliveryFailures7d: number;
  deliverySent7d: number;
}

const JOB_STATUS = { failed: 'Com falha', queued: 'Na fila', running: 'Em execução', done: 'Concluídas' } as const;

export function OperationPage(p: PageProps) {
  const [status, setStatus] = useState<keyof typeof JOB_STATUS>('failed');
  const overview = useData<OverviewData>('/overview', p.revision);
  const jobs = useData<Job[]>(`/jobs?status=${status}&limit=100`, p.revision);
  const email = useData<EmailInfo>('/email', p.revision);
  const [to, setTo] = useState('');
  const o = overview.data;
  const testEmail = (send: boolean) =>
    p.action(async () => {
      const r = await request<{ ok: boolean; message: string }>('/email/test', 'POST', send ? { to } : {});
      if (!r.ok) throw new Error(r.message);
    }, send ? `Mensagem de teste enviada para ${to}.` : 'Conexão com o servidor de e-mail funcionando.');

  return (
    <DataState error={overview.error || email.error} loading={!o || !email.data}>
      {o && <HealthAlerts data={o} />}
      <Card title="Fila de tarefas">
        <div className="vf-platform-metrics">
          <div>
            <span className="vf-muted">Processo da fila</span>
            <strong className="vf-platform-metric-text">{!o?.queue.worker ? 'Em outro serviço' : o.queue.alive ? 'Ativo' : 'Sem resposta'}</strong>
            <span className="vf-muted">{o?.queue.lastTickAt ? `último sinal ${formatDateTimeBr(o.queue.lastTickAt)}` : 'este servidor só atende a API'}</span>
          </div>
          <div>
            <span className="vf-muted">Esperando agora</span>
            <strong>{o?.queued_jobs ?? 0}</strong>
            <span className="vf-muted">{o?.queued_jobs ? `a mais antiga há ${ageLabel(o.oldest_queued_seconds)}` : 'nada parado'}</span>
          </div>
          <div>
            <span className="vf-muted">Em execução</span>
            <strong>{o?.running_jobs ?? 0}</strong>
          </div>
          <div>
            <span className="vf-muted">Com falha</span>
            <strong>{o?.failed_jobs ?? 0}</strong>
            <span className="vf-muted">{o?.failed_jobs_24h ?? 0} nas últimas 24 h</span>
          </div>
        </div>
      </Card>

      <Card
        title="Tarefas"
        actions={
          <Select
            aria-label="Situação das tarefas"
            value={status}
            options={Object.entries(JOB_STATUS).map(([value, label]) => ({ value, label }))}
            onChange={(e) => setStatus(e.target.value as keyof typeof JOB_STATUS)}
          />
        }
      >
        <DataState error={jobs.error} loading={!jobs.data}>
          {!jobs.data?.length ? (
            <p className="vf-muted">{status === 'failed' ? 'Nenhuma tarefa com falha.' : 'Nenhuma tarefa nesta situação.'}</p>
          ) : (
            <>
              {status === 'failed' && p.owner && (
                <div className="vf-inline">
                  <Button
                    kind="tertiary"
                    icon={<Trash2 size={16} />}
                    disabled={p.busy}
                    onClick={() => p.confirm(`Dispensar as ${jobs.data!.length} falhas listadas? Elas saem da lista; nada é reenviado.`, () => request('/jobs/dismiss', 'POST', { ids: jobs.data!.map((j) => j.id) }), 'Falhas dispensadas.')}
                  >
                    Dispensar as listadas
                  </Button>
                </div>
              )}
              <div className="vf-table-wrap">
                <table className="vf-table">
                  <thead>
                    <tr>
                      <th>Tarefa</th>
                      <th>Escritório</th>
                      <th>Quando</th>
                      <th>Tentativas</th>
                      {status === 'failed' && <th>Motivo</th>}
                      {status === 'failed' && p.owner && <th className="actions">Opções</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.data.map((j) => (
                      <tr key={j.id}>
                        <td className="vf-mono">{j.type}</td>
                        <td>{j.officeName ?? <span className="vf-muted">Sistema</span>}</td>
                        <td>{formatDateTimeBr(j.finishedAt ?? j.createdAt)}</td>
                        <td>
                          {j.attempts} de {j.maxAttempts}
                        </td>
                        {status === 'failed' && <td className="vf-platform-error">{j.error ?? '—'}</td>}
                        {status === 'failed' && p.owner && (
                          <td className="actions">
                            <Button kind="secondary" size="sm" icon={<RefreshCw size={14} />} disabled={p.busy} onClick={() => void p.action(() => request(`/jobs/${j.id}/retry`, 'POST', {}), 'Tarefa recolocada na fila.')}>
                              Tentar de novo
                            </Button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </DataState>
      </Card>

      <Card
        title="E-mail do sistema"
        actions={email.data?.configured ? <Tag tone="success" icon={<CheckCircle2 size={14} />}>Configurado</Tag> : <Tag tone="warning" icon={<TriangleAlert size={14} />}>Não configurado</Tag>}
      >
        <div className="vf-stack">
          <p className="vf-muted">
            É por ele que saem convites, redefinições de senha e avisos de segurança. O servidor é definido na variável SMTP_URL (a senha nunca aparece aqui); o do escritório, quando existe, fica de reserva para esses e-mails.
          </p>
          {email.data?.configured ? (
            <p>
              <span className="vf-mono">
                {email.data.host}:{email.data.port}
              </span>{' '}
              · {email.data.secure ? 'TLS' : 'STARTTLS quando disponível'} · remetente <span className="vf-mono">{email.data.from}</span>
            </p>
          ) : (
            <Alert tone="warning" title="Defina SMTP_URL no servidor">
              Exemplo: <span className="vf-mono">smtps://usuario:senha@smtp.exemplo.com:465</span>. Com SMTP_REQUIRED=true a API recusa iniciar sem ele{email.data?.required ? ' (ligado neste servidor)' : ''}.
            </Alert>
          )}
          <div className="vf-inline">
            <Tag tone={email.data?.accountMailFailures7d ? 'danger' : 'neutral'}>{email.data?.accountMailFailures7d ?? 0} e-mail(s) de conta com falha em 7 dias</Tag>
            <Tag tone={email.data?.deliveryFailures7d ? 'warning' : 'neutral'}>{email.data?.deliveryFailures7d ?? 0} envio(s) dos escritórios com falha</Tag>
            <Tag>{email.data?.deliverySent7d ?? 0} enviado(s)</Tag>
          </div>
          {p.owner && email.data?.configured && (
            <form
              className="vf-inline vf-platform-test"
              onSubmit={(e) => {
                e.preventDefault();
                void testEmail(true);
              }}
            >
              <Input label="Enviar teste para" type="email" required placeholder="voce@exemplo.com" value={to} onChange={(e) => setTo(e.target.value)} />
              <Button type="submit" icon={<Send size={16} />} loading={p.busy}>
                Enviar teste
              </Button>
              <Button kind="secondary" disabled={p.busy} onClick={() => void testEmail(false)}>
                Só testar a conexão
              </Button>
            </form>
          )}
        </div>
      </Card>
    </DataState>
  );
}

// ---------------------------------------------------------------- configurações
interface SettingsData {
  stored: { signupEnabled: boolean | null; trialDays: number | null; trialDeclarationLimit: number | null; supportEmail: string | null; termsUrl: string | null; privacyUrl: string | null };
  effective: { signupEnabled: boolean; trialDays: number; trialDeclarationLimit: number; supportEmail: string | null };
  environment: { signupEnabled: boolean; supportEmail: string | null };
}

export function SettingsPage(p: PageProps) {
  const { data, error } = useData<SettingsData>('/settings', p.revision);
  const [form, setForm] = useState<{ signup: 'open' | 'closed'; trialDays: string; trialLimit: string; supportEmail: string; termsUrl: string; privacyUrl: string } | null>(null);
  useEffect(() => {
    if (!data) return;
    setForm({
      signup: data.stored.signupEnabled === false ? 'closed' : 'open',
      trialDays: data.stored.trialDays?.toString() ?? '',
      trialLimit: data.stored.trialDeclarationLimit?.toString() ?? '',
      supportEmail: data.stored.supportEmail ?? '',
      termsUrl: data.stored.termsUrl ?? '',
      privacyUrl: data.stored.privacyUrl ?? '',
    });
  }, [data]);
  const save = () =>
    p.action(
      () =>
        request('/settings', 'PUT', {
          signupEnabled: form!.signup === 'closed' ? false : null,
          trialDays: form!.trialDays ? Number(form!.trialDays) : null,
          trialDeclarationLimit: form!.trialLimit ? Number(form!.trialLimit) : null,
          supportEmail: form!.supportEmail.trim() || null,
          termsUrl: form!.termsUrl.trim() || null,
          privacyUrl: form!.privacyUrl.trim() || null,
        }),
      'Configurações salvas.',
    );
  const locked = !p.owner;
  return (
    <DataState error={error} loading={!data || !form}>
      {form && data && (
        <form
          className="vf-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {locked && <Alert tone="primary" title="Somente o proprietário altera estas configurações." />}
          <Card title="Cadastro de novos escritórios">
            <div className="vf-stack">
              {!data.environment.signupEnabled && (
                <Alert tone="warning" title="Cadastro fechado no servidor">
                  A variável SIGNUP_ENABLED=false fecha o cadastro de vez; a opção abaixo só volta a valer quando ela for removida.
                </Alert>
              )}
              <div className="vf-platform-form-grid">
                <Select
                  label="Quem pode criar uma conta"
                  disabled={locked}
                  value={form.signup}
                  options={[
                    { value: 'open', label: 'Aberto: qualquer escritório se cadastra' },
                    { value: 'closed', label: 'Fechado: só por contato com o suporte' },
                  ]}
                  onChange={(e) => setForm({ ...form, signup: e.target.value as 'open' | 'closed' })}
                />
                <Input label="E-mail do suporte" type="email" disabled={locked} placeholder={data.environment.supportEmail ?? 'suporte@exemplo.com'} help="Aparece nos avisos de plano vencido e no cadastro fechado." value={form.supportEmail} onChange={(e) => setForm({ ...form, supportEmail: e.target.value })} />
                <Input label="Dias da avaliação gratuita" type="number" min={1} max={365} disabled={locked} placeholder="30" value={form.trialDays} onChange={(e) => setForm({ ...form, trialDays: e.target.value })} />
                <Input label="Declarações na avaliação" type="number" min={1} disabled={locked} placeholder="30" value={form.trialLimit} onChange={(e) => setForm({ ...form, trialLimit: e.target.value })} />
              </div>
              <p className="vf-muted">
                Vale agora: cadastro {data.effective.signupEnabled ? 'aberto' : 'fechado'}, avaliação de {data.effective.trialDays} dias com até {data.effective.trialDeclarationLimit} declarações. A mudança vale para os próximos cadastros; os contratos já criados não mudam.
              </p>
            </div>
          </Card>
          <Card title="Termos de uso e privacidade">
            <div className="vf-stack">
              <p className="vf-muted">Com o endereço dos termos preenchido, a conta só é criada com o aceite, que fica registrado no escritório junto com o endereço aceito. Publicou uma versão nova? Troque o endereço.</p>
              <div className="vf-platform-form-grid">
                <Input label="Endereço dos termos de uso" type="url" disabled={locked} placeholder="https://..." value={form.termsUrl} onChange={(e) => setForm({ ...form, termsUrl: e.target.value })} />
                <Input label="Endereço da política de privacidade" type="url" disabled={locked} placeholder="https://..." value={form.privacyUrl} onChange={(e) => setForm({ ...form, privacyUrl: e.target.value })} />
              </div>
            </div>
          </Card>
          {!locked && (
            <div className="vf-inline">
              <Button type="submit" loading={p.busy}>
                Salvar configurações
              </Button>
            </div>
          )}
        </form>
      )}
    </DataState>
  );
}

// ---------------------------------------------------------------- minha conta
export function AccountPage({ p, me, onToken, onChange }: { p: PageProps; me: { name: string; email: string; role: string; twoFactorEnabled?: boolean }; onToken: (token: string) => void; onChange: () => void }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', repeat: '' });
  const mismatch = Boolean(form.repeat) && form.repeat !== form.newPassword;
  return (
    <>
      <Card title="Sua conta">
        <p>
          <strong>{me.name}</strong> · {me.email} · {me.role === 'owner' ? 'Proprietário' : 'Desenvolvedor'}
        </p>
        <p className="vf-muted">Nome e papel são alterados pelo proprietário em Equipe do sistema.</p>
      </Card>
      <Card title="Trocar senha">
        <form
          className="vf-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void p.action(async () => {
              const r = await request<{ token: string }>('/change-password', 'POST', { currentPassword: form.currentPassword, newPassword: form.newPassword });
              // as outras sessões caíram; esta continua com o token novo
              savePlatformToken(r.token);
              onToken(r.token);
              setForm({ currentPassword: '', newPassword: '', repeat: '' });
            }, 'Senha alterada. As outras sessões desta conta foram encerradas.');
          }}
        >
          <div className="vf-platform-form-grid">
            <PasswordInput label="Senha atual" autoComplete="current-password" required value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} />
            <span />
            <PasswordInput label="Senha nova" autoComplete="new-password" required minLength={12} help="Pelo menos 12 caracteres." value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} />
            <PasswordInput label="Repita a senha nova" autoComplete="new-password" required error={mismatch ? 'As senhas não conferem.' : undefined} value={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.value })} />
          </div>
          <div className="vf-inline">
            <Button type="submit" loading={p.busy} disabled={mismatch || form.newPassword.length < 12}>
              Trocar senha
            </Button>
          </div>
          <p className="vf-muted">Esqueceu a senha e não consegue entrar? Quem tem acesso ao servidor redefine com o comando deploy/reset-platform-password.sh.</p>
        </form>
      </Card>
      <TwoFactorCard enabled={Boolean(me.twoFactorEnabled)} post={(path, body) => request(path, 'POST', body)} onChange={onChange} />
    </>
  );
}

// ---------------------------------------------------------------- ficha do escritório
interface OfficeDetail {
  id: string;
  name: string;
  cpfCnpj: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  createdAt: string;
  blockedAt: string | null;
  blockedReason: string | null;
  termsAcceptedAt: string | null;
  termsVersion: string | null;
  owners: { name: string; email: string; lastLoginAt: string | null }[];
  usage: { activeUsers: number; customers: number; declarations: number; declarationsThisYear: number; storageBytes: number; files: number; failedJobs7d: number; lastLoginAt: string | null };
  contracts: { id: string; name: string; plan: string; year: number; declarationLimit: number | null; startsAt: string; expiresAt: string; status: string }[];
}

export function OfficeDetailCard({ id, p, onClose }: { id: string; p: PageProps; onClose: () => void }) {
  const { data, error } = useData<OfficeDetail>(`/offices/${id}`, p.revision);
  const [reason, setReason] = useState('');
  const [blocking, setBlocking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState('');
  return (
    <Card
      title={data?.name ?? 'Escritório'}
      actions={
        <Button kind="tertiary" onClick={onClose}>
          Fechar ficha
        </Button>
      }
    >
      <DataState error={error} loading={!data}>
        {data && (
          <div className="vf-stack">
            {data.blockedAt && (
              <Alert tone="danger" title={`Acesso suspenso em ${formatDateTimeBr(data.blockedAt)}`}>
                {data.blockedReason ?? 'Sem motivo registrado.'} Colaboradores, portal do cliente, extensão e sincronizador ficam sem acesso; os dados continuam guardados.
              </Alert>
            )}
            <p className="vf-muted">
              {data.cpfCnpj ? `${formatCpfCnpj(data.cpfCnpj)} · ` : ''}
              {data.email ?? 'sem e-mail'} · {data.phone ?? 'sem telefone'} · {[data.city, data.state].filter(Boolean).join(' / ') || 'localidade não informada'} · cadastrado em {dateBr(data.createdAt)}
            </p>
            <div className="vf-platform-metrics">
              <div>
                <span className="vf-muted">Clientes</span>
                <strong>{data.usage.customers}</strong>
              </div>
              <div>
                <span className="vf-muted">Declarações</span>
                <strong>{data.usage.declarationsThisYear}</strong>
                <span className="vf-muted">neste exercício · {data.usage.declarations} no total</span>
              </div>
              <div>
                <span className="vf-muted">Colaboradores ativos</span>
                <strong>{data.usage.activeUsers}</strong>
                <span className="vf-muted">último acesso: {when(data.usage.lastLoginAt)}</span>
              </div>
              <div>
                <span className="vf-muted">Arquivos</span>
                <strong className="vf-platform-metric-text">{formatBytes(data.usage.storageBytes)}</strong>
                <span className="vf-muted">{data.usage.files} arquivo(s)</span>
              </div>
            </div>
            {data.usage.failedJobs7d > 0 && <Alert tone="warning" title={`${data.usage.failedJobs7d} tarefa(s) deste escritório falharam em 7 dias`} />}
            <div>
              <h3 className="vf-platform-subtitle">Responsáveis pela conta</h3>
              {data.owners.map((o) => (
                <p key={o.email}>
                  {o.name} · {o.email} <span className="vf-muted">· último acesso: {when(o.lastLoginAt)}</span>{' '}
                  {p.owner && (
                    <Button
                      kind="tertiary"
                      size="sm"
                      disabled={p.busy}
                      onClick={() =>
                        p.confirm(
                          `Desligar a verificação em duas etapas de ${o.name}? Use só a pedido do próprio dono, que perdeu o celular e os códigos de recuperação.`,
                          () => request(`/offices/${id}/reset-2fa`, 'POST', { email: o.email }),
                          'Duas etapas desligadas. A pessoa entra com a senha.',
                        )
                      }
                    >
                      Desligar duas etapas
                    </Button>
                  )}
                </p>
              ))}
              <p className="vf-muted">{data.termsAcceptedAt ? `Termos aceitos em ${formatDateTimeBr(data.termsAcceptedAt)} (${data.termsVersion ?? 'versão não registrada'}).` : 'Sem aceite de termos registrado (cadastro anterior aos termos ou termos não publicados).'}</p>
            </div>
            <div>
              <h3 className="vf-platform-subtitle">Contratos</h3>
              {!data.contracts.length && <p className="vf-muted">Nenhum contrato: o escritório usa sem limite de plano.</p>}
              {data.contracts.map((c) => (
                <p key={c.id}>
                  {c.name} · {c.plan} · {c.year} · {dateBr(c.startsAt)} até {dateBr(c.expiresAt)} · {c.declarationLimit === null ? 'ilimitado' : `${c.declarationLimit} declarações`} ·{' '}
                  {CONTRACT_STATUS[c.status as keyof typeof CONTRACT_STATUS] ?? c.status}
                </p>
              ))}
            </div>
            {p.owner &&
              (data.blockedAt ? (
                <div className="vf-inline">
                  <Button kind="secondary" icon={<CheckCircle2 size={16} />} disabled={p.busy} onClick={() => p.confirm(`Liberar o acesso de ${data.name}?`, () => request(`/offices/${id}/block`, 'PUT', { blocked: false }), 'Acesso liberado.')}>
                    Liberar acesso
                  </Button>
                </div>
              ) : blocking ? (
                <form
                  className="vf-stack"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void p.action(async () => {
                      await request(`/offices/${id}/block`, 'PUT', { blocked: true, reason });
                      setBlocking(false);
                      setReason('');
                    }, 'Acesso suspenso.');
                  }}
                >
                  <Textarea label="Motivo da suspensão" required rows={2} maxLength={500} help="Fica registrado na auditoria. O escritório vê apenas que o acesso está suspenso." value={reason} onChange={(e) => setReason(e.target.value)} />
                  <div className="vf-inline">
                    <Button type="submit" kind="danger" loading={p.busy} disabled={!reason.trim()}>
                      Suspender acesso
                    </Button>
                    <Button kind="tertiary" onClick={() => setBlocking(false)}>
                      Cancelar
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="vf-inline">
                  <Button kind="tertiary" icon={<Ban size={16} />} onClick={() => setBlocking(true)}>
                    Suspender acesso
                  </Button>
                </div>
              ))}
            {p.owner && data.blockedAt && (
              <div className="vf-stack">
                <h3 className="vf-platform-subtitle">Excluir o escritório</h3>
                {deleting ? (
                  <form
                    className="vf-stack"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void p.action(async () => {
                        await request(`/offices/${id}`, 'DELETE', { confirmName: typed });
                        onClose();
                      }, 'Escritório excluído em definitivo.');
                    }}
                  >
                    <Alert tone="danger" title="Esta ação não tem volta">
                      Apaga clientes, declarações, cobranças, colaboradores e todos os arquivos de {data.name}. Antes, confirme que o escritório recebeu a cópia dos dados (o backup é gerado por ele em Backup).
                    </Alert>
                    <Input label={`Digite o nome do escritório para confirmar: ${data.name}`} value={typed} onChange={(e) => setTyped(e.target.value)} />
                    <div className="vf-inline">
                      <Button type="submit" kind="danger" loading={p.busy} disabled={typed.trim().toLowerCase() !== data.name.trim().toLowerCase()}>
                        Excluir em definitivo
                      </Button>
                      <Button kind="tertiary" onClick={() => setDeleting(false)}>
                        Cancelar
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div className="vf-inline">
                    <span className="vf-muted">Encerramento de contrato ou pedido de eliminação dos dados.</span>
                    <Button kind="tertiary" icon={<Trash2 size={16} />} onClick={() => setDeleting(true)}>
                      Excluir escritório
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </DataState>
    </Card>
  );
}
