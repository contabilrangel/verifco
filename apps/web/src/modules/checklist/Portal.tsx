import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { Link, NavLink, Navigate, Outlet, useOutletContext, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  FileText,
  Home,
  ListChecks,
  LogOut,
  MessageCircle,
  ReceiptText,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import { BUDGET_CATEGORIES } from '@verifco/shared';
import { Alert, Button, Card, ConfirmDialog, Input, Loading, Modal, Progress, Tag, Textarea, cx, useToast, type Tone } from '../../ds';
import { ApiError, errorMessage } from '../../lib/api';
import { formatDate, formatMoney } from '../../lib/format';
import { CustomerPayments } from '../finance/CustomerPayments';
import type { CustomerPayment } from '../finance/types';
import { ChatThread, Composer, timeOf, type ChatEntry } from './Chat';
import { CustomerChecklist } from './CustomerChecklist';
import { customerClient, formatBytes, maskCpfInput, portalSession, publicApi, type CustomerClient, type PortalSession } from './customerApi';
import { PublicFrame, type OfficeContact } from './PublicFrame';
import type { CustomerTone, PortalBudget as BasePortalBudget, PortalMessage, PortalOverview as BasePortalOverview } from './types';

/** Orçamento do portal; aprovado e faturado, traz as parcelas com o link de pagamento. */
type PortalBudget = BasePortalBudget & { categoryLabel?: string; payments?: CustomerPayment[] | null };

/** Quota do DARF do imposto como o portal devolve em `/portal/overview`. */
export interface PortalDarf {
  id: string;
  exerciseYear: number;
  quotaNumber: number;
  dueDate: string;
  /** Valor cadastrado; nas quotas geradas a partir da 2ª é só o principal (veja `amount`). */
  valueCents: number;
  /** Valor com os juros até o vencimento, quando o cadastro guarda só o principal. */
  amount: { totalCents: number | null; note: string | null } | null;
  status: 'open' | 'paid' | 'overdue';
  paidAt: string | null;
  hasFile: boolean;
}
type PortalOverview = BasePortalOverview & { darfs?: PortalDarf[] };

const DARF_STATUS: Record<PortalDarf['status'], { label: string; tone: Tone }> = {
  open: { label: 'Em aberto', tone: 'warning' },
  paid: { label: 'Paga', tone: 'success' },
  overdue: { label: 'Vencida', tone: 'danger' },
};

interface PortalCtx {
  session: PortalSession;
  client: CustomerClient;
}
const usePortal = () => useOutletContext<PortalCtx>();

// ---------------------------------------------------------------------------
// Layout e login
// ---------------------------------------------------------------------------
export function PortalLayout() {
  const qc = useQueryClient();
  const [session, setSession] = useState<PortalSession | null>(() => portalSession.get());
  const [expired, setExpired] = useState(false);
  const logout = (wasExpired = false) => {
    portalSession.set(null);
    setSession(null);
    setExpired(wasExpired);
    qc.removeQueries({ queryKey: ['portal'] });
    qc.removeQueries({ queryKey: ['customer-checklist'] });
  };
  const client = useMemo(() => (session ? customerClient(session.token, () => logout(true)) : null), [session]);
  const overview = useQuery({
    queryKey: ['portal', 'overview'],
    queryFn: () => client!.get<PortalOverview>('/portal/overview'),
    enabled: Boolean(client),
    refetchInterval: 60_000,
  });
  // contato do escritório no rodapé: o cliente sempre tem a quem recorrer
  const me = useQuery({
    queryKey: ['portal', 'me'],
    queryFn: () => client!.get<{ office: OfficeContact }>('/portal/me'),
    enabled: Boolean(client),
    staleTime: 10 * 60_000,
    retry: false,
  });

  if (!session || !client) {
    return (
      <PublicFrame subtitle="Portal do cliente">
        <PortalLogin
          expired={expired}
          onLogged={(s) => {
            portalSession.set(s);
            setExpired(false);
            setSession(s);
          }}
        />
      </PublicFrame>
    );
  }
  const unread = overview.data?.unreadMessages ?? 0;
  const checklistId = overview.data?.checklist?.id;
  return (
    <PublicFrame
      officeName={session.officeName}
      subtitle="Portal do cliente"
      contact={me.data?.office}
      right={
        <Button kind="tertiary" size="sm" icon={<LogOut />} onClick={() => logout()}>
          Sair
        </Button>
      }
      nav={
        <nav className="ck-nav" aria-label="Portal">
          <NavLink to="/portal" end className={({ isActive }) => cx('vf-tab', isActive && 'active')}>
            <Home />
            Início
          </NavLink>
          {checklistId && (
            <NavLink to={`/portal/checklist/${checklistId}`} className={({ isActive }) => cx('vf-tab', isActive && 'active')}>
              <ListChecks />
              Checklist
            </NavLink>
          )}
          <NavLink to="/portal/mensagens" className={({ isActive }) => cx('vf-tab', isActive && 'active')}>
            <MessageCircle />
            Mensagens
            {unread > 0 && <span className="vf-badge">{unread}</span>}
          </NavLink>
        </nav>
      }
    >
      <Outlet context={{ session, client } satisfies PortalCtx} />
    </PublicFrame>
  );
}

function PortalLogin({ expired, onLogged }: { expired: boolean; onLogged: (s: PortalSession) => void }) {
  const [cpf, setCpf] = useState('');
  const [code, setCode] = useState('');
  const [offices, setOffices] = useState<{ id: string; name: string }[] | null>(null);
  const [officeId, setOfficeId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const r = await publicApi.post<{ token?: string; customer?: { firstName: string }; office?: { name: string }; needsOffice?: boolean; offices?: { id: string; name: string }[] }>('/portal/login', {
        cpf,
        code,
        ...(officeId ? { officeId } : {}),
      });
      if (r.needsOffice && r.offices) {
        setOffices(r.offices);
        setOfficeId(r.offices[0]?.id ?? '');
        return;
      }
      if (r.token) onLogged({ token: r.token, firstName: r.customer?.firstName ?? '', officeName: r.office?.name ?? '' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ck-login">
      <Card>
        <form className="vf-stack" style={{ '--gap': '20px' } as CSSProperties} onSubmit={submit}>
          <div className="vf-stack" style={{ '--gap': '8px' } as CSSProperties}>
            <span className="ck-login__icon">
              <ShieldCheck />
            </span>
            <h1 className="vf-text-lg">Portal do cliente</h1>
            <p className="vf-muted">Acompanhe sua declaração de Imposto de Renda, envie documentos e fale com o seu escritório.</p>
          </div>
          {expired && <Alert tone="warning">Sua sessão terminou. Entre de novo para continuar.</Alert>}
          {error && <Alert tone="danger">{error}</Alert>}
          {offices ? (
            <div className="vf-stack" role="radiogroup" aria-label="Escritório">
              <p className="vf-text-sm-bold">Você é cliente de mais de um escritório. Qual deseja acessar?</p>
              {offices.map((o) => (
                <label key={o.id} className="ck-option">
                  <input type="radio" name="office" value={o.id} checked={officeId === o.id} onChange={() => setOfficeId(o.id)} />
                  <strong>{o.name}</strong>
                </label>
              ))}
            </div>
          ) : (
            <>
              <Input label="CPF" required inputMode="numeric" autoComplete="username" placeholder="000.000.000-00" value={cpf} onChange={(e) => setCpf(maskCpfInput(e.target.value))} />
              <Input
                label="Código de acesso"
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6 dígitos"
                className="ck-code-input"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D+/g, '').slice(0, 6))}
                help="Seu escritório envia o código por e-mail. Não recebeu? Peça a ele."
              />
            </>
          )}
          <Button type="submit" block loading={loading} disabled={cpf.replace(/\D/g, '').length !== 11 || code.length !== 6 || (offices !== null && !officeId)}>
            {offices ? 'Continuar' : 'Entrar'}
          </Button>
          {offices && (
            <Button kind="tertiary" block onClick={() => (setOffices(null), setOfficeId(''))}>
              Voltar
            </Button>
          )}
        </form>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------
const toneIcon = (tone: CustomerTone) => (tone === 'success' ? <CheckCircle2 /> : tone === 'warning' || tone === 'danger' ? <AlertTriangle /> : <Clock />);

export function PortalHome() {
  const { session, client } = usePortal();
  const toast = useToast();
  const qc = useQueryClient();
  const overview = useQuery({ queryKey: ['portal', 'overview'], queryFn: () => client.get<PortalOverview>('/portal/overview') });
  // orçamentos ficam no módulo financeiro; se a rota ainda não existir, o cartão some
  const budgets = useQuery({
    queryKey: ['portal', 'budgets'],
    queryFn: async () => {
      try {
        const r = await client.get<PortalBudget[] | { data?: PortalBudget[]; budgets?: PortalBudget[] }>('/portal/budgets');
        return Array.isArray(r) ? r : (r.data ?? r.budgets ?? []);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501)) return null;
        throw e;
      }
    },
    retry: false,
  });
  const [deciding, setDeciding] = useState<{ budget: PortalBudget; action: 'approve' | 'reject' } | null>(null);
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: (v: { id: string; action: 'approve' | 'reject'; reason?: string }) => client.post(`/portal/budgets/${v.id}/${v.action}`, v.action === 'reject' && v.reason ? { reason: v.reason } : {}),
    onSuccess: (_r, v) => {
      toast.success(v.action === 'approve' ? 'Orçamento aprovado. Obrigado!' : 'Orçamento recusado. O escritório foi avisado.');
      setDeciding(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['portal'] });
      // a cobrança é emitida logo depois da aprovação: busca de novo para o link de pagamento aparecer
      if (v.action === 'approve') for (const ms of [4000, 12_000, 30_000]) setTimeout(() => void qc.invalidateQueries({ queryKey: ['portal', 'budgets'] }), ms);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const download = (d: { id: string; filename: string }) => client.open(`/portal/documents/${d.id}`, d.filename, false).catch((e) => toast.error(errorMessage(e)));
  const downloadDarf = (d: PortalDarf) => client.open(`/portal/darfs/${d.id}/file`, `darf-${d.exerciseYear}-quota-${d.quotaNumber}.pdf`, false).catch((e) => toast.error(errorMessage(e)));

  if (overview.isLoading) return <Loading />;
  if (!overview.data) return <Alert tone="danger">{errorMessage(overview.error)}</Alert>;
  const o = overview.data;
  const pendingBudgets = (budgets.data ?? []).filter((b) => !b.status || b.status === 'sent');
  // aprovados continuam no portal, com as parcelas e o link para pagar
  const billedBudgets = (budgets.data ?? []).filter((b) => b.status === 'approved' && b.payments?.length);
  const darfs = o.darfs ?? [];
  const budgetTitle = (b: PortalBudget) => b.categoryLabel || BUDGET_CATEGORIES[b.category as keyof typeof BUDGET_CATEGORIES] || 'Honorários';
  const [current, previous] = o.declarations;

  return (
    <div className="vf-stack">
      <div>
        <h1 className="ck-hello">Olá, {session.firstName}!</h1>
        <p className="vf-muted">Aqui você acompanha seu Imposto de Renda com {session.officeName}.</p>
      </div>

      <div className="vf-grid" style={{ alignItems: 'start' }}>
        {[current, previous].filter(Boolean).map((d, i) => (
          <Card key={d.exerciseYear} title={i === 0 ? `Sua declaração ${d.exerciseYear}` : `Declaração ${d.exerciseYear}`}>
            <div className="ck-status">
              <span className={`ck-status__icon ck-status__icon--${d.status.tone}`}>{toneIcon(d.status.tone)}</span>
              <div className="vf-stack" style={{ '--gap': '4px' } as CSSProperties}>
                <strong>{d.status.title}</strong>
                <span className="vf-muted vf-text-sm">{d.status.description}</span>
                {d.refundCents > 0 && <span className="vf-text-sm">Restituição: <strong className="vf-success-text">{formatMoney(d.refundCents)}</strong></span>}
                {d.taxDueCents > 0 && <span className="vf-text-sm">Imposto a pagar: <strong>{formatMoney(d.taxDueCents)}</strong></span>}
                <span className="vf-muted vf-text-xs">Ano-calendário {d.calendarYear}</span>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {o.pendencies.length > 0 && (
        <Card title="O escritório precisa de">
          <ul className="ck-list">
            {o.pendencies.map((p) => (
              <li key={p.id}>
                <span className="vf-inline" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' } as CSSProperties}>
                  <AlertTriangle size={18} style={{ color: 'var(--color-warning)', flexShrink: 0, marginTop: 1 }} />
                  <span>{p.description}</span>
                </span>
                {p.dueDate && <Tag tone="warning">até {formatDate(p.dueDate)}</Tag>}
              </li>
            ))}
          </ul>
          <p className="vf-muted vf-text-xs" style={{ marginTop: 12 }}>
            Envie pelo checklist ou responda nas mensagens.
          </p>
        </Card>
      )}

      {o.checklist && (
        <Card title={`Checklist de documentos ${o.checklist.exerciseYear}`} actions={o.checklist.finishedAt ? o.checklist.sectionsPending ? <Tag tone="warning">Faltam documentos</Tag> : <Tag tone="success">Concluído</Tag> : undefined}>
          <div className="vf-stack" style={{ '--gap': '12px' } as CSSProperties}>
            <div className="vf-inline vf-between">
              <span className="vf-text-sm-bold">
                {o.checklist.progress.resolved} de {o.checklist.progress.total} itens resolvidos
              </span>
              <span className="vf-muted vf-text-xs">
                {o.checklist.sectionsDone} de {o.checklist.sectionsTotal} seções
              </span>
            </div>
            <Progress value={o.checklist.progress.percent} />
            <div>
              <Link to={`/portal/checklist/${o.checklist.id}`} className="vf-btn">
                <ListChecks />
                {o.checklist.readOnly ? 'Ver checklist' : o.checklist.sectionsPending ? 'Enviar o que faltava' : o.checklist.finishedAt ? 'Ver checklist' : o.checklist.progress.resolved ? 'Continuar checklist' : 'Começar checklist'}
              </Link>
            </div>
          </div>
        </Card>
      )}

      {pendingBudgets.length > 0 && (
        <Card title="Orçamentos para aprovar">
          <ul className="ck-list">
            {pendingBudgets.map((b) => (
              <li key={b.id} style={{ flexWrap: 'wrap' }}>
                <span className="vf-stack" style={{ '--gap': '2px' } as CSSProperties}>
                  <strong>{b.description || BUDGET_CATEGORIES[b.category as keyof typeof BUDGET_CATEGORIES] || 'Orçamento'}</strong>
                  <span className="vf-muted vf-text-sm">
                    {formatMoney(b.totalCents ?? b.amountCents ?? 0)}
                    {b.installments && b.installments > 1 ? ` em ${b.installments}x` : ''}
                    {b.exerciseYear ? ` · IR ${b.exerciseYear}` : ''}
                  </span>
                </span>
                <span className="ck-actions">
                  <Button size="sm" icon={<ThumbsUp />} onClick={() => setDeciding({ budget: b, action: 'approve' })}>
                    Aprovar
                  </Button>
                  <Button size="sm" kind="secondary" icon={<ThumbsDown />} onClick={() => setDeciding({ budget: b, action: 'reject' })}>
                    Recusar
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {billedBudgets.length > 0 && (
        <Card title="Pagamentos">
          {billedBudgets.map((b) => (
            <section key={b.id} className="ck-budget" aria-label={`Pagamentos de ${budgetTitle(b)}`}>
              <span className="vf-stack" style={{ '--gap': '2px' } as CSSProperties}>
                <strong>
                  {budgetTitle(b)}
                  {b.exerciseYear ? ` · IR ${b.exerciseYear}` : ''}
                </strong>
                <span className="vf-muted vf-text-sm">Honorários de {formatMoney(b.totalCents ?? b.amountCents ?? 0)}</span>
              </span>
              <CustomerPayments payments={b.payments ?? []} />
            </section>
          ))}
        </Card>
      )}

      {darfs.length > 0 && (
        <Card title="DARF do imposto">
          <ul className="ck-list">
            {darfs.map((d) => (
              <li key={d.id} style={{ flexWrap: 'wrap' }}>
                <span className="ck-darf">
                  <strong>
                    {d.quotaNumber}ª quota · IR {d.exerciseYear}
                  </strong>
                  <span className="vf-text-sm">
                    {formatMoney(d.amount?.totalCents ?? d.valueCents)} · {d.status === 'paid' && d.paidAt ? `paga em ${formatDate(d.paidAt)}` : `vencimento em ${formatDate(d.dueDate)}`}
                  </span>
                  {d.amount?.note && d.status !== 'paid' && <span className="vf-muted vf-text-xs">{d.amount.note}</span>}
                </span>
                <span className="ck-actions" style={{ alignItems: 'center' }}>
                  <Tag tone={DARF_STATUS[d.status].tone}>{DARF_STATUS[d.status].label}</Tag>
                  {d.hasFile ? (
                    <Button size="sm" kind="secondary" icon={<Download />} aria-label={`Baixar a guia da ${d.quotaNumber}ª quota de ${d.exerciseYear}`} onClick={() => void downloadDarf(d)}>
                      Baixar guia
                    </Button>
                  ) : (
                    d.status !== 'paid' && <span className="vf-muted vf-text-xs">O escritório vai enviar a guia</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="vf-muted vf-text-xs" style={{ marginTop: 12 }}>
            O DARF é pago no seu banco, com o código de barras ou o Pix da guia. Vale sempre o valor que está na guia.
          </p>
        </Card>
      )}

      <Card title="Documentos do escritório">
        {o.documents.length ? (
          <ul className="ck-list">
            {o.documents.map((d) => (
              <li key={d.id}>
                <span className="vf-inline" style={{ flexWrap: 'nowrap', minWidth: 0 } as CSSProperties}>
                  <FileText size={18} style={{ color: 'var(--color-interactive)', flexShrink: 0 }} />
                  <span className="vf-stack" style={{ '--gap': '0px', minWidth: 0 } as CSSProperties}>
                    <span style={{ overflowWrap: 'anywhere' }}>{d.filename}</span>
                    <span className="vf-muted vf-text-xs">
                      {formatDate(d.createdAt)} · {formatBytes(d.size)}
                    </span>
                  </span>
                </span>
                <Button size="sm" kind="secondary" icon={<Download />} onClick={() => void download(d)}>
                  Baixar
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="vf-muted">Quando o escritório compartilhar algo com você (declaração, recibo, DARF), aparece aqui.</p>
        )}
      </Card>

      <Card title="Mensagens" actions={o.unreadMessages ? <Tag tone="primary">{o.unreadMessages} nova(s)</Tag> : undefined}>
        <div className="vf-inline vf-between">
          <span className="vf-muted">{o.unreadMessages ? 'O escritório mandou mensagem para você.' : 'Tire dúvidas e converse com o escritório.'}</span>
          <Link to="/portal/mensagens" className="vf-btn vf-btn--secondary">
            <MessageCircle />
            Abrir conversa
          </Link>
        </div>
      </Card>

      <ConfirmDialog
        open={deciding?.action === 'approve'}
        title="Aprovar este orçamento?"
        message={
          <span className="vf-inline">
            <ReceiptText size={16} /> Ao aprovar, o escritório começa o trabalho e a cobrança é gerada.
          </span>
        }
        confirmLabel="Aprovar"
        loading={decide.isPending}
        onConfirm={() => deciding && decide.mutate({ id: deciding.budget.id, action: 'approve' })}
        onClose={() => setDeciding(null)}
      />
      <Modal
        open={deciding?.action === 'reject'}
        title="Recusar este orçamento?"
        onClose={() => setDeciding(null)}
        width={460}
        footer={
          <>
            <Button kind="secondary" onClick={() => setDeciding(null)}>
              Voltar
            </Button>
            <Button kind="danger" loading={decide.isPending} onClick={() => deciding && decide.mutate({ id: deciding.budget.id, action: 'reject', reason: reason.trim() || undefined })}>
              Recusar
            </Button>
          </>
        }
      >
        <div className="vf-stack">
          <span className="vf-muted">O escritório será avisado.</span>
          <Textarea label="Quer contar o motivo? (opcional)" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} />
        </div>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Checklist e mensagens
// ---------------------------------------------------------------------------
export function PortalChecklist() {
  const { client } = usePortal();
  const { checklistId } = useParams();
  if (!checklistId) return <Navigate to="/portal" replace />;
  return <CustomerChecklist checklistId={checklistId} client={client} />;
}

export function PortalMessages() {
  const { client, session } = usePortal();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['portal', 'messages'];
  const q = useQuery({ queryKey: key, queryFn: () => client.get<{ officeName: string; messages: PortalMessage[]; unread: number }>('/portal/messages'), refetchInterval: 20_000 });
  const unread = q.data?.unread ?? 0;
  useEffect(() => {
    if (!unread) return;
    void client.post('/portal/messages/read').then(() => qc.invalidateQueries({ queryKey: ['portal'] }));
  }, [unread, client, qc]);
  const send = useMutation({
    mutationFn: (body: string) => client.post<{ messages: PortalMessage[] }>('/portal/messages', { body }),
    onSuccess: (r) => {
      qc.setQueryData(key, r);
      toast.success('Mensagem enviada ao escritório.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <Alert tone="danger">{errorMessage(q.error)}</Alert>;
  const entries: ChatEntry[] = q.data.messages.map((m) => ({
    id: m.id,
    mine: m.fromMe,
    body: m.body,
    createdAt: m.createdAt,
    meta: [m.fromMe ? 'Você' : q.data!.officeName || session.officeName, timeOf(m.createdAt), m.channel === 'whatsapp' ? 'também no WhatsApp' : null, m.fromMe ? (m.readAt ? 'lida' : 'enviada') : null]
      .filter(Boolean)
      .join(' · '),
  }));
  return (
    <Card title={`Conversa com ${q.data.officeName || session.officeName}`}>
      <div className="vf-stack">
        <ChatThread entries={entries} empty="Escreva sua dúvida. O escritório responde por aqui." />
        <Composer sending={send.isPending} onSend={(text) => send.mutateAsync(text)} />
      </div>
    </Card>
  );
}
