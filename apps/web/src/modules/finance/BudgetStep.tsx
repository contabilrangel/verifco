import { useState } from 'react';
import { Check, ChevronDown, Copy, FileSignature, History, Link2, Lock, MoreHorizontal, Pencil, Plus, Send, Trash2, X } from 'lucide-react';
import { todayIso } from '@verifco/shared';
import { Alert, Button, Card, Checkbox, ConfirmDialog, EmptyState, IconButton, Input, Loading, Menu, MenuItem, Modal, Tag, useToast } from '../../ds';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { formatDate, formatDateTime, formatMoney } from '../../lib/format';
import { useYear } from '../../lib/year';
import { useCustomer } from '../customers/customerContext';
import { BillingPanel } from './BillingPanel';
import { BudgetFormModal } from './BudgetForm';
import type { Budget, BudgetList } from './types';
import { BudgetStatusTag, PAYMENT_STATUS, budgetTypeLabel, formatNumber, paymentStatusTone } from './ui';

type Action = { kind: 'approve' | 'reject' | 'delete' | 'send' | 'link'; budget: Budget } | null;

/** Etapa "Orçamento" da aba IRPF do cliente. */
export function BudgetStep() {
  const { customer } = useCustomer();
  const { year } = useYear();
  const { can } = useAuth();
  const toast = useToast();
  const key = ['finance', 'budgets', customer.id, year];
  const q = useApi<BudgetList>(key, `/finance/customers/${customer.id}/budgets?year=${year}`);
  const [form, setForm] = useState<{ budget: Budget | null } | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [link, setLink] = useState<string | null>(null);
  const invalidate = [['finance', 'budgets', customer.id]];

  const approve = useAction((b: Budget) => api.post(`/finance/budgets/${b.id}/approve`), {
    success: 'Orçamento aprovado. Faturamento gerado.',
    invalidate: [...invalidate, ['customer', customer.id]],
    onSuccess: () => setAction(null),
  });
  const reject = useAction((b: Budget) => api.post(`/finance/budgets/${b.id}/reject`), { success: 'Orçamento marcado como recusado.', invalidate, onSuccess: () => setAction(null) });
  const remove = useAction((b: Budget) => api.del(`/finance/budgets/${b.id}`), { success: 'Orçamento excluído.', invalidate, onSuccess: () => setAction(null) });
  const newLink = useAction((b: Budget) => api.post<{ link: string }>(`/finance/budgets/${b.id}/link`), {
    invalidate,
    onSuccess: (r) => {
      setAction(null);
      setLink(r.link);
    },
  });

  const authorization = async () => {
    try {
      await api.open(`/finance/customers/${customer.id}/authorization?year=${year}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não foi possível gerar a autorização.');
    }
  };
  const sendAuth = useAction((channel: 'email' | 'whatsapp') => api.post(`/finance/customers/${customer.id}/authorization/send`, { year, channel }), {
    success: 'Autorização enviada para a fila de envio.',
  });
  const [authSend, setAuthSend] = useState<'email' | 'whatsapp' | null>(null);

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Alert tone="danger" title="Não foi possível carregar os orçamentos.">Atualize a página ou tente novamente.</Alert>;
  const { data: list, previous, settings } = q.data;
  const contact = { email: q.data.customer.hasEmail, mobile: q.data.customer.hasMobile };
  const activeBudget = list.some((b) => ['draft', 'sent', 'approved'].includes(b.status));
  const canAuthorize = activeBudget || settings.allowAuthorizationWithoutBudget;

  return (
    <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
      <div className="vf-inline vf-between">
        <div>
          <h2 className="vf-text-lg">Orçamento e faturamento</h2>
          <p className="vf-muted vf-text-sm">O faturamento é criado quando o orçamento é aprovado — pelo escritório ou pelo cliente no link enviado.</p>
        </div>
        <div className="vf-inline">
          <Menu
            trigger={(t) => (
              <Button kind="secondary" icon={<FileSignature />} onClick={t} title={canAuthorize ? undefined : 'Cadastre um orçamento ou permita a autorização sem orçamento nas preferências.'}>
                Autorização <ChevronDown size={16} />
              </Button>
            )}
          >
            {(close) => (
              <>
                <MenuItem disabled={!canAuthorize} onClick={() => (close(), void authorization())}>
                  Abrir PDF
                </MenuItem>
                {can('budget.send') && (
                  <>
                    <MenuItem disabled={!canAuthorize || !contact.email} onClick={() => (close(), setAuthSend('email'))}>
                      Enviar por e-mail
                    </MenuItem>
                    <MenuItem disabled={!canAuthorize || !contact.mobile} onClick={() => (close(), setAuthSend('whatsapp'))}>
                      Enviar por WhatsApp
                    </MenuItem>
                  </>
                )}
                {!canAuthorize && <div className="vf-text-xs vf-muted" style={{ padding: '8px 12px', maxWidth: 260 }}>Disponível após cadastrar um orçamento para {year}.</div>}
              </>
            )}
          </Menu>
          {can('budget.create') && (
            <Button icon={<Plus />} onClick={() => setForm({ budget: null })}>
              Novo orçamento
            </Button>
          )}
        </div>
      </div>

      {previous && (
        <div className="vf-fin-reference">
          <History size={16} />
          <span>
            Orçamento de {previous.exerciseYear}: <strong>{previous.categoryLabel}</strong> · {formatMoney(previous.totalCents)}
            {previous.installments > 1 ? ` em ${previous.installments}x` : ''}
            {previous.paymentMethodName ? ` · ${previous.paymentMethodName}` : ''}
            {previous.discountPercent ? ` · desconto de ${formatNumber(previous.discountPercent)}%` : ''}
          </span>
          <BudgetStatusTag status={previous.status} />
        </div>
      )}

      {list.length === 0 ? (
        <Card>
          <EmptyState
            title={`Nenhum orçamento para ${year}`}
            description="Monte a proposta com valor fixo ou calculado pela tabela de cobrança e envie ao cliente para aprovação."
            action={can('budget.create') && <Button onClick={() => setForm({ budget: null })}>Novo orçamento</Button>}
          />
        </Card>
      ) : (
        list.map((b) => (
          <BudgetCard
            key={b.id}
            budget={b}
            contact={contact}
            onEdit={() => setForm({ budget: b })}
            onAction={(kind) => setAction({ kind, budget: b })}
          />
        ))
      )}

      <BudgetFormModal
        open={Boolean(form)}
        budget={form?.budget ?? null}
        customerId={customer.id}
        year={year}
        hasEmail={contact.email}
        hasMobile={contact.mobile}
        previous={previous}
        onClose={() => setForm(null)}
        onSaved={(r) => {
          setForm(null);
          if (r.link) setLink(r.link);
        }}
      />

      <ConfirmDialog
        open={action?.kind === 'approve'}
        title="Aprovar orçamento"
        message={
          action?.kind === 'approve'
            ? `O faturamento de ${formatMoney(action.budget.totalCents)} será criado em ${action.budget.installments} parcela(s) mensal(is), com a 1ª vencendo em ${formatDate(action.budget.billingStartDate ?? todayIso())}.`
            : ''
        }
        confirmLabel="Aprovar e faturar"
        loading={approve.isPending}
        onConfirm={() => action && approve.mutate(action.budget)}
        onClose={() => setAction(null)}
      />
      <ConfirmDialog
        open={action?.kind === 'reject'}
        title="Marcar como recusado"
        message="Use quando o cliente recusar a proposta. O link de aprovação deixa de aceitar a aprovação."
        confirmLabel="Marcar como recusado"
        danger
        loading={reject.isPending}
        onConfirm={() => action && reject.mutate(action.budget)}
        onClose={() => setAction(null)}
      />
      <ConfirmDialog
        open={action?.kind === 'delete'}
        title="Excluir orçamento"
        message="O orçamento será excluído e o link enviado ao cliente deixará de funcionar. Esta ação não pode ser desfeita."
        confirmLabel="Excluir"
        danger
        loading={remove.isPending}
        onConfirm={() => action && remove.mutate(action.budget)}
        onClose={() => setAction(null)}
      />
      <ConfirmDialog
        open={action?.kind === 'link'}
        title="Gerar link de aprovação"
        message="Um novo link será criado (válido por 30 dias) e o link enviado antes deixa de funcionar. Nada é enviado ao cliente: copie e compartilhe como preferir."
        confirmLabel="Gerar link"
        loading={newLink.isPending}
        onConfirm={() => action && newLink.mutate(action.budget)}
        onClose={() => setAction(null)}
      />
      <SendBudgetModal budget={action?.kind === 'send' ? action.budget : null} contact={contact} customerId={customer.id} onClose={() => setAction(null)} onSent={(l) => (setAction(null), setLink(l))} />
      <LinkModal link={link} onClose={() => setLink(null)} />
      <ConfirmDialog
        open={Boolean(authSend)}
        title="Enviar documento de autorização"
        message={`O documento de autorização de ${year} será enviado em PDF por ${authSend === 'email' ? 'e-mail' : 'WhatsApp'} para ${customer.name}.`}
        confirmLabel="Enviar"
        loading={sendAuth.isPending}
        onConfirm={() => authSend && sendAuth.mutate(authSend, { onSuccess: () => setAuthSend(null) })}
        onClose={() => setAuthSend(null)}
      />
    </div>
  );
}

function BudgetCard({
  budget: b,
  contact,
  onEdit,
  onAction,
}: {
  budget: Budget;
  contact: { email: boolean; mobile: boolean };
  onEdit: () => void;
  onAction: (k: 'approve' | 'reject' | 'delete' | 'send' | 'link') => void;
}) {
  const { can } = useAuth();
  const approved = b.status === 'approved';
  const sendable = ['draft', 'sent', 'rejected'].includes(b.status);
  const decidable = !['approved', 'canceled'].includes(b.status);
  const timeline = [
    b.sentAt && `Enviado em ${formatDateTime(b.sentAt)}${b.linkExpiresAt ? ` · link válido até ${formatDate(b.linkExpiresAt)}` : ''}`,
    b.approvedAt && `Aprovado em ${formatDateTime(b.approvedAt)}${b.approvedBy ? ` por ${b.approvedBy}` : ''}`,
    b.rejectedAt && b.status === 'rejected' && `Recusado em ${formatDateTime(b.rejectedAt)}`,
  ].filter(Boolean);
  const hasMenu = (sendable && can('budget.send')) || (!approved && can('budget.delete'));

  return (
    <Card>
      <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
        <div className="vf-inline vf-between" style={{ alignItems: 'flex-start' }}>
          <div className="vf-stack" style={{ '--gap': '6px' } as React.CSSProperties}>
            <div className="vf-inline">
              <h3 className="vf-text-md-bold">{b.categoryLabel}</h3>
              <BudgetStatusTag status={b.status} />
              {approved && <Tag tone={paymentStatusTone(b.paymentStatus)}>{PAYMENT_STATUS[b.paymentStatus]}</Tag>}
              <span className="vf-text-xs vf-muted">{budgetTypeLabel(b.type)}</span>
            </div>
            {timeline.length > 0 && <span className="vf-text-xs vf-muted">{timeline.join(' · ')}</span>}
          </div>
          <div className="vf-inline">
            {sendable && can('budget.send') && (
              <Button size="sm" kind="secondary" icon={<Send />} onClick={() => onAction('send')} disabled={!contact.email && !contact.mobile} title={!contact.email && !contact.mobile ? 'Cadastre e-mail ou celular do cliente' : undefined}>
                {b.status === 'sent' ? 'Reenviar' : 'Enviar'}
              </Button>
            )}
            {decidable && can('budget.approve') && (
              <>
                <Button size="sm" icon={<Check />} onClick={() => onAction('approve')}>
                  Aprovar
                </Button>
                {b.status !== 'rejected' && (
                  <Button size="sm" kind="tertiary" icon={<X />} onClick={() => onAction('reject')}>
                    Recusar
                  </Button>
                )}
              </>
            )}
            {can('budget.edit') && b.status !== 'canceled' && (
              <IconButton label="Editar orçamento" onClick={onEdit}>
                <Pencil />
              </IconButton>
            )}
            {hasMenu && (
              <Menu
                trigger={(t) => (
                  <IconButton label="Mais ações do orçamento" onClick={t}>
                    <MoreHorizontal />
                  </IconButton>
                )}
              >
                {(close) => (
                  <>
                    {sendable && can('budget.send') && (
                      <MenuItem icon={<Link2 />} onClick={() => (close(), onAction('link'))}>
                        Gerar link de aprovação
                      </MenuItem>
                    )}
                    {!approved && can('budget.delete') && (
                      <MenuItem icon={<Trash2 />} danger onClick={() => (close(), onAction('delete'))}>
                        Excluir orçamento
                      </MenuItem>
                    )}
                  </>
                )}
              </Menu>
            )}
          </div>
        </div>

        <dl className="vf-fin-facts">
          <div>
            <dt>Valor</dt>
            <dd>{formatMoney(b.amountCents)}</dd>
          </div>
          <div>
            <dt>Desconto</dt>
            <dd>{b.discountPercent ? `${formatNumber(b.discountPercent)}%` : '—'}</dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd className="vf-fin-strong">{formatMoney(b.totalCents)}</dd>
          </div>
          <div>
            <dt>Pagamento</dt>
            <dd>
              {b.paymentMethodName ?? '—'}
              {b.installments > 1 ? ` · ${b.installments}x` : ''}
            </dd>
          </div>
          <div>
            <dt>1ª cobrança</dt>
            <dd>{b.billingStartDate ? formatDate(b.billingStartDate) : '—'}</dd>
          </div>
          <div>
            <dt>Tabela</dt>
            <dd>{b.priceTableName ?? '—'}</dd>
          </div>
        </dl>

        {(b.description || b.internalNote) && (
          <div className="vf-stack" style={{ '--gap': '8px' } as React.CSSProperties}>
            {b.description && <p className="vf-text-sm" style={{ whiteSpace: 'pre-wrap' }}>{b.description}</p>}
            {b.internalNote && (
              <p className="vf-fin-note">
                <Lock size={12} /> {b.internalNote}
              </p>
            )}
          </div>
        )}

        {b.billing && (
          <div className="vf-stack" style={{ '--gap': '12px', borderTop: '1px solid var(--color-border)', paddingTop: 16 } as React.CSSProperties}>
            <h4 className="vf-text-sm-bold">Faturamento</h4>
            <BillingPanel billing={b.billing} customerId={b.customerId} contact={contact} />
          </div>
        )}
      </div>
    </Card>
  );
}

function SendBudgetModal({
  budget,
  contact,
  customerId,
  onClose,
  onSent,
}: {
  budget: Budget | null;
  contact: { email: boolean; mobile: boolean };
  customerId: string;
  onClose: () => void;
  onSent: (link: string) => void;
}) {
  const [email, setEmail] = useState(true);
  const [wa, setWa] = useState(false);
  const channels = [...(email && contact.email ? ['email'] : []), ...(wa && contact.mobile ? ['whatsapp'] : [])];
  const send = useAction(() => api.post<{ link: string }>(`/finance/budgets/${budget!.id}/send`, { channels }), {
    success: 'Orçamento enviado ao cliente.',
    invalidate: [['finance', 'budgets', customerId], ['customer', customerId]],
    onSuccess: (r) => onSent(r.link),
  });
  return (
    <Modal
      open={Boolean(budget)}
      title="Enviar orçamento ao cliente"
      onClose={onClose}
      width={500}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button icon={<Send />} disabled={!channels.length} loading={send.isPending} onClick={() => send.mutate(undefined)}>
            Enviar
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <span>
          Proposta de <strong>{budget?.categoryLabel}</strong> no valor de <strong>{budget ? formatMoney(budget.totalCents) : ''}</strong>.
        </span>
        <Checkbox label={contact.email ? 'Por e-mail' : 'Por e-mail (cliente sem e-mail cadastrado)'} checked={email && contact.email} disabled={!contact.email} onChange={(e) => setEmail(e.target.checked)} />
        <Checkbox label={contact.mobile ? 'Por WhatsApp' : 'Por WhatsApp (cliente sem celular cadastrado)'} checked={wa && contact.mobile} disabled={!contact.mobile} onChange={(e) => setWa(e.target.checked)} />
        <Alert tone="primary">O cliente recebe um link para aprovar ou recusar, válido por 30 dias. {budget?.status === 'sent' ? 'O link enviado antes deixa de funcionar.' : ''}</Alert>
      </div>
    </Modal>
  );
}

function LinkModal({ link, onClose }: { link: string | null; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal
      open={Boolean(link)}
      title="Link de aprovação"
      onClose={onClose}
      width={560}
      footer={
        <Button kind="secondary" onClick={onClose}>
          Fechar
        </Button>
      }
    >
      <div className="vf-stack">
        <span className="vf-muted">Este é o link que o cliente usa para ver e aprovar a proposta. Por segurança, ele só é exibido agora.</span>
        <div className="vf-inline" style={{ flexWrap: 'nowrap' }}>
          <div className="vf-grow">
            <Input aria-label="Link de aprovação" readOnly value={link ?? ''} onFocus={(e) => e.target.select()} />
          </div>
          <Button
            icon={<Copy />}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link ?? '');
                toast.success('Link copiado.');
              } catch {
                toast.error('Não foi possível copiar. Selecione e copie o link.');
              }
            }}
          >
            Copiar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
