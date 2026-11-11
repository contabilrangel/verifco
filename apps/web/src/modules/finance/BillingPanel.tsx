import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCircle2, ExternalLink, FileText, Mail, MessageCircle, MoreHorizontal, Pencil, RefreshCw, Send, Undo2 } from 'lucide-react';
import { todayIso } from '@verifco/shared';
import { Alert, Button, ConfirmDialog, IconButton, Input, Menu, MenuItem, Modal, MoneyInput, Stat, Textarea } from '../../ds';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/hooks';
import { formatDate, formatDateTime, formatMoney } from '../../lib/format';
import type { Billing, Installment } from './types';
import { InstallmentStatusTag } from './ui';

type Dialog =
  | { kind: 'receive'; inst: Installment }
  | { kind: 'edit'; inst: Installment }
  | { kind: 'reopen'; inst: Installment }
  | { kind: 'cancel'; inst: Installment }
  | { kind: 'send'; inst: Installment; channel: 'email' | 'whatsapp' }
  | { kind: 'charge'; inst: Installment; channel: 'email' | 'whatsapp' }
  | null;

const PROVIDERS: Record<string, string> = { asaas: 'Asaas', omie: 'Omie' };

/**
 * Parcela com cobrança emitida no Asaas/Omie e a integração ativa: o que o escritório muda aqui
 * (vencimento, valor, recebimento, desfazer, cancelar) é aplicado primeiro no provedor; se ele
 * recusar, a API devolve o erro e nada muda.
 */
export const issuedAtProvider = (billing: Billing, inst: Installment) => Boolean(inst.externalId && billing.provider && billing.externalSync?.integrationReady);

export function BillingPanel({ billing, customerId, contact }: { billing: Billing; customerId: string; contact: { email: boolean; mobile: boolean } }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [emitOpen, setEmitOpen] = useState(false);
  const invalidate = [['finance', 'budgets', customerId]];
  const close = () => setDialog(null);
  const provider = billing.provider ? (PROVIDERS[billing.provider] ?? billing.provider) : '';

  // emissão em andamento no provedor: atualiza até os links chegarem (ou a falha aparecer)
  const sync = billing.externalSync;
  const emitting = Boolean(sync && (sync.status === 'running' || (sync.status === 'queued' && !sync.error)));
  useEffect(() => {
    if (!emitting) return;
    const t = setInterval(() => void qc.invalidateQueries({ queryKey: ['finance', 'budgets', customerId] }), 5000);
    return () => clearInterval(t);
  }, [emitting, qc, customerId]);
  const emit = useAction(() => api.post(`/finance/billings/${billing.id}/sync`), {
    success: 'Emissão da cobrança colocada na fila.',
    invalidate,
    onSuccess: () => setEmitOpen(false),
  });

  const receipt = useAction((inst: Installment) => api.post<{ receiptNumber: number; fileId: string }>(`/finance/installments/${inst.id}/receipt`), {
    success: (r) => `Recibo nº ${r.receiptNumber} gerado.`,
    invalidate,
    onSuccess: (r) => void api.open(`/files/${r.fileId}?inline=1`),
  });
  const send = useAction((d: { inst: Installment; channel: 'email' | 'whatsapp' }) => api.post(`/finance/installments/${d.inst.id}/receipt/send`, { channel: d.channel }), {
    success: (_r) => 'Recibo enviado para a fila de envio.',
    invalidate,
    onSuccess: close,
  });
  const reopen = useAction((inst: Installment) => api.post(`/finance/installments/${inst.id}/reopen`), {
    success: 'Recebimento desfeito.',
    invalidate,
    onSuccess: close,
  });
  const charge = useAction((d: { inst: Installment; channel: 'email' | 'whatsapp' }) => api.post(`/finance/installments/${d.inst.id}/charge/send`, { channel: d.channel }), {
    success: 'Cobrança enviada para a fila de envio.',
    invalidate,
    onSuccess: close,
  });
  const openReceipt = async (inst: Installment) => {
    if (inst.receiptFileId) await api.open(`/files/${inst.receiptFileId}?inline=1`);
  };

  const total = billing.installments.length;
  const managed = (i: Installment) => issuedAtProvider(billing, i);
  /** Aviso das janelas: a mudança vale também no provedor, ou só aqui (integração desativada). */
  const scope = (i: Installment | null | undefined): ProviderScope => (!i?.externalId ? null : managed(i) ? 'managed' : 'unmanaged');
  return (
    <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
      <div className="vf-fin-stats">
        <Stat label="Faturado" value={formatMoney(billing.totalCents)} hint={`${total} parcela(s)${billing.provider ? ` · ${PROVIDERS[billing.provider] ?? billing.provider}` : ''}`} />
        <Stat label="Recebido" value={formatMoney(billing.paidCents)} tone={billing.paidCents > 0 ? 'success' : undefined} />
        <Stat label="Em aberto" value={formatMoney(billing.openCents)} />
        <Stat label="Vencido" value={formatMoney(billing.overdueCents)} tone={billing.overdueCents > 0 ? 'danger' : undefined} />
      </div>
      <ExternalSyncNotice billing={billing} canEmit={can('billing.edit')} onEmit={() => setEmitOpen(true)} />
      {billing.installments.some((i) => managed(i) && i.status !== 'canceled') && <ProviderManagedNotice provider={billing.provider} />}
      <div className="vf-table-wrap vf-fin-subtable">
        <table className="vf-table">
          <thead>
            <tr>
              <th>Parcela</th>
              <th>Vencimento</th>
              <th className="num">Valor</th>
              <th>Situação</th>
              <th>Pagamento</th>
              <th>Recibo</th>
              <th className="actions" aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {billing.installments.map((i) => {
              const open = i.status === 'open' || i.status === 'overdue';
              return (
                <tr key={i.id}>
                  <td className="vf-mono">
                    {i.number}/{total}
                  </td>
                  <td>
                    <div className="vf-stack" style={{ '--gap': '2px' } as React.CSSProperties}>
                      <span>{formatDate(i.dueDate)}</span>
                      {i.externalUrl && i.status !== 'canceled' && (
                        <a href={i.externalUrl} target="_blank" rel="noopener noreferrer" className="vf-text-xs vf-inline" style={{ '--gap': '4px' } as React.CSSProperties}>
                          <ExternalLink size={12} /> Boleto / Pix
                        </a>
                      )}
                      {open && i.externalUrl && <span className="vf-text-xs vf-muted">{i.chargeSentAt ? `cobrança enviada ${formatDateTime(i.chargeSentAt)}` : 'cobrança não enviada ao cliente'}</span>}
                    </div>
                  </td>
                  <td className="num">{formatMoney(i.amountCents)}</td>
                  <td>
                    <div className="vf-stack" style={{ '--gap': '2px' } as React.CSSProperties}>
                      <span>
                        <InstallmentStatusTag status={i.status} />
                      </span>
                      {i.status === 'canceled' && (i.canceledAt || i.cancelReason) && (
                        <span className="vf-text-xs vf-muted">{[i.canceledAt && formatDate(i.canceledAt), i.cancelReason].filter(Boolean).join(' · ')}</span>
                      )}
                    </div>
                  </td>
                  <td className="vf-text-sm">
                    {i.paidAt ? (
                      <>
                        {formatDate(i.paidAt)}
                        {i.paidAmountCents !== null && i.paidAmountCents !== i.amountCents && <div className="vf-text-xs vf-muted">{formatMoney(i.paidAmountCents)}</div>}
                      </>
                    ) : (
                      <span className="vf-muted">—</span>
                    )}
                  </td>
                  <td className="vf-text-sm">
                    {i.receiptNumber ? (
                      <div className="vf-stack" style={{ '--gap': '2px' } as React.CSSProperties}>
                        <button type="button" className="vf-fin-link" onClick={() => void openReceipt(i)} disabled={!i.receiptFileId}>
                          nº {String(i.receiptNumber).padStart(4, '0')}
                        </button>
                        {i.receiptSentAt && <span className="vf-text-xs vf-muted">enviado {formatDateTime(i.receiptSentAt)}</span>}
                      </div>
                    ) : (
                      <span className="vf-muted">—</span>
                    )}
                  </td>
                  <td className="actions">
                    <div className="vf-inline" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      {open && can('billing.receive') && (
                        <Button size="sm" kind="secondary" icon={<CheckCircle2 />} onClick={() => setDialog({ kind: 'receive', inst: i })}>
                          Receber
                        </Button>
                      )}
                      {i.status === 'paid' && can('billing.receipt_generate') && (
                        <Button size="sm" kind="secondary" icon={<FileText />} loading={receipt.isPending && receipt.variables?.id === i.id} onClick={() => receipt.mutate(i)}>
                          {i.receiptNumber ? 'Recibo' : 'Gerar recibo'}
                        </Button>
                      )}
                      <InstallmentMenu inst={i} onPick={setDialog} contact={contact} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ReceiveModal inst={dialog?.kind === 'receive' ? dialog.inst : null} provider={provider} scope={scope(dialog?.inst)} onClose={close} invalidate={invalidate} />
      <EditInstallmentModal inst={dialog?.kind === 'edit' ? dialog.inst : null} provider={provider} scope={scope(dialog?.inst)} onClose={close} invalidate={invalidate} />
      <CancelInstallmentModal inst={dialog?.kind === 'cancel' ? dialog.inst : null} total={total} provider={provider} scope={scope(dialog?.inst)} onClose={close} invalidate={invalidate} />
      <ConfirmDialog
        open={dialog?.kind === 'charge'}
        title="Enviar cobrança"
        message={
          dialog?.kind === 'charge'
            ? `O link de pagamento da parcela ${dialog.inst.number}/${total} (${formatMoney(dialog.inst.amountCents)}, vencimento em ${formatDate(dialog.inst.dueDate)}) será enviado por ${dialog.channel === 'email' ? 'e-mail' : 'WhatsApp'} ao cliente.${dialog.inst.chargeSentAt ? ` Já foi enviado em ${formatDateTime(dialog.inst.chargeSentAt)}.` : ''}`
            : ''
        }
        confirmLabel="Enviar"
        loading={charge.isPending}
        onConfirm={() => dialog?.kind === 'charge' && charge.mutate({ inst: dialog.inst, channel: dialog.channel })}
        onClose={close}
      />
      <ConfirmDialog
        open={dialog?.kind === 'send'}
        title="Enviar recibo"
        message={
          dialog?.kind === 'send'
            ? `O recibo da parcela ${dialog.inst.number}/${total} (${formatMoney(dialog.inst.paidAmountCents ?? dialog.inst.amountCents)}) será enviado em PDF por ${dialog.channel === 'email' ? 'e-mail' : 'WhatsApp'} ao cliente.${dialog.inst.receiptNumber ? '' : ' O recibo será gerado agora.'}`
            : ''
        }
        confirmLabel="Enviar"
        loading={send.isPending}
        onConfirm={() => dialog?.kind === 'send' && send.mutate({ inst: dialog.inst, channel: dialog.channel })}
        onClose={close}
      />
      <ConfirmDialog
        open={emitOpen}
        title={`Emitir cobrança no ${provider}`}
        message={`As parcelas em aberto ainda sem boleto ou Pix serão enviadas agora ao ${provider}. As que já têm cobrança emitida não são duplicadas.`}
        confirmLabel="Emitir"
        loading={emit.isPending}
        onConfirm={() => emit.mutate(undefined)}
        onClose={() => setEmitOpen(false)}
      />
      <ConfirmDialog
        open={dialog?.kind === 'reopen'}
        title="Desfazer recebimento"
        message={`A parcela volta a ficar em aberto. Use quando o recebimento foi lançado por engano.${
          dialog?.kind === 'reopen' && scope(dialog.inst) === 'unmanaged' ? ` ${unmanagedExternal(provider)}` : ''
        }${dialog?.kind === 'reopen' && scope(dialog.inst) === 'managed' ? ` ${undoAtProvider(billing.provider)}` : ''}`}
        confirmLabel="Desfazer"
        danger
        loading={reopen.isPending}
        onConfirm={() => dialog?.kind === 'reopen' && reopen.mutate(dialog.inst)}
        onClose={close}
      />
    </div>
  );
}

/** Situação da emissão no Asaas/Omie: em andamento, nova tentativa agendada ou falha (com "Emitir novamente"). */
function ExternalSyncNotice({ billing, canEmit, onEmit }: { billing: Billing; canEmit: boolean; onEmit: () => void }) {
  const sync = billing.externalSync;
  if (!billing.provider || !sync) return null;
  const label = PROVIDERS[billing.provider] ?? billing.provider;
  const pending = billing.installments.some((i) => (i.status === 'open' || i.status === 'overdue') && !i.externalId);
  const action = (text: string) =>
    canEmit && (
      <Button size="sm" kind="secondary" icon={<RefreshCw />} onClick={onEmit}>
        {text}
      </Button>
    );
  const activate = !sync.integrationReady && <span>Ao ativar a integração em Meu escritório › Integrações, a cobrança é emitida automaticamente.</span>;
  if (sync.status === 'running' || (sync.status === 'queued' && !sync.error)) {
    return <Alert tone="primary">A cobrança está sendo emitida no {label}. Os links de pagamento aparecem aqui assim que ficarem prontos.</Alert>;
  }
  if (sync.status === 'queued') {
    return (
      <Alert tone="warning" title={`Não foi possível emitir a cobrança no ${label}`}>
        <div className="vf-fin-sync">
          <span>{sync.error}</span>
          <span>
            {sync.nextAttemptAt ? `Nova tentativa automática em ${formatDateTime(sync.nextAttemptAt)}` : 'Nova tentativa automática em instantes'} (tentativa {sync.attempts} de {sync.maxAttempts}).
          </span>
          {action('Tentar agora')}
        </div>
      </Alert>
    );
  }
  if (!pending) return null;
  if (sync.status === 'failed') {
    return (
      <Alert tone="danger" title={`Falha ao emitir a cobrança no ${label}`}>
        <div className="vf-fin-sync">
          <span>{sync.error}</span>
          {activate}
          {action('Emitir novamente')}
        </div>
      </Alert>
    );
  }
  return (
    <Alert tone="warning" title={`Cobrança não emitida no ${label}`}>
      <div className="vf-fin-sync">
        <span>Há parcela em aberto sem boleto ou Pix no {label}.</span>
        {activate}
        {action('Emitir cobrança')}
      </div>
    </Alert>
  );
}

/** Explica que as mudanças nas parcelas emitidas no provedor também valem lá. */
function ProviderManagedNotice({ provider }: { provider: string | null }) {
  const name = provider ? (PROVIDERS[provider] ?? provider) : 'provedor';
  return (
    <Alert tone="primary" title={`Parcelas com cobrança emitida no ${name}`}>
      Alterar vencimento ou valor, registrar recebimento, desfazer e cancelar por aqui também muda a {provider === 'omie' ? 'conta a receber no Omie' : 'cobrança no Asaas'}. Se o {name} recusar, nada muda no
      Verifco. {provider === 'omie' ? 'O que for feito direto no Omie é conferido periodicamente.' : 'Pagamento por boleto, Pix ou cartão não é desfeito por aqui: estorne no Asaas.'}
    </Alert>
  );
}

/** A mudança vale também no provedor (`managed`), só no Verifco (`unmanaged`: integração desativada) ou a parcela não tem cobrança lá. */
type ProviderScope = 'managed' | 'unmanaged' | null;

/** Aviso para parcela com cobrança no provedor quando a integração está desativada (controle manual). */
const unmanagedExternal = (provider: string) =>
  `Esta parcela tem cobrança emitida no ${provider || 'provedor'}, mas a integração está desativada: a mudança vale só no Verifco. Altere ou cancele a cobrança no ${provider || 'provedor'} para o cliente não pagar em dobro.`;

/** O que acontece no provedor ao desfazer um recebimento. */
const undoAtProvider = (provider: string | null) =>
  provider === 'omie'
    ? 'A baixa também é cancelada no Omie.'
    : 'O recebimento em dinheiro também é desfeito no Asaas. Se o cliente pagou por boleto, Pix ou cartão, o Asaas não deixa desfazer: estorne a cobrança por lá.';

function ScopeNotice({ scope, provider, children }: { scope: ProviderScope; provider: string; children: React.ReactNode }) {
  if (scope === 'unmanaged') return <Alert tone="warning">{unmanagedExternal(provider)}</Alert>;
  return scope === 'managed' ? <Alert tone="primary">{children}</Alert> : null;
}

function InstallmentMenu({ inst, onPick, contact }: { inst: Installment; onPick: (d: Dialog) => void; contact: { email: boolean; mobile: boolean } }) {
  const { can } = useAuth();
  const open = inst.status === 'open' || inst.status === 'overdue';
  const paid = inst.status === 'paid';
  // o link de pagamento só existe depois de a cobrança ser emitida no provedor
  const chargeable = open && Boolean(inst.externalUrl) && can('budget.send');
  const items = [
    open && can('billing.edit'),
    chargeable,
    paid && can('billing.receipt_send') && (inst.receiptNumber || can('billing.receipt_generate')),
    paid && !inst.receiptNumber && can('billing.receive'),
  ].some(Boolean);
  if (!items) return <span style={{ display: 'inline-block', width: 36 }} />;
  return (
    <Menu
      trigger={(t) => (
        <IconButton label={`Mais ações da parcela ${inst.number}`} onClick={t}>
          <MoreHorizontal />
        </IconButton>
      )}
    >
      {(close) => (
        <>
          {chargeable && (
            <>
              <MenuItem icon={<Send />} disabled={!contact.email} onClick={() => (close(), onPick({ kind: 'charge', inst, channel: 'email' }))}>
                Enviar cobrança por e-mail
              </MenuItem>
              <MenuItem icon={<MessageCircle />} disabled={!contact.mobile} onClick={() => (close(), onPick({ kind: 'charge', inst, channel: 'whatsapp' }))}>
                Enviar cobrança por WhatsApp
              </MenuItem>
            </>
          )}
          {open && can('billing.edit') && (
            <MenuItem icon={<Pencil />} onClick={() => (close(), onPick({ kind: 'edit', inst }))}>
              Alterar vencimento ou valor
            </MenuItem>
          )}
          {paid && can('billing.receipt_send') && (inst.receiptNumber || can('billing.receipt_generate')) && (
            <>
              <MenuItem icon={<Mail />} disabled={!contact.email} onClick={() => (close(), onPick({ kind: 'send', inst, channel: 'email' }))}>
                Enviar recibo por e-mail
              </MenuItem>
              <MenuItem icon={<MessageCircle />} disabled={!contact.mobile} onClick={() => (close(), onPick({ kind: 'send', inst, channel: 'whatsapp' }))}>
                Enviar recibo por WhatsApp
              </MenuItem>
            </>
          )}
          {paid && !inst.receiptNumber && can('billing.receive') && (
            <MenuItem icon={<Undo2 />} danger onClick={() => (close(), onPick({ kind: 'reopen', inst }))}>
              Desfazer recebimento
            </MenuItem>
          )}
          {open && can('billing.edit') && (
            <MenuItem icon={<Ban />} danger onClick={() => (close(), onPick({ kind: 'cancel', inst }))}>
              Cancelar parcela
            </MenuItem>
          )}
        </>
      )}
    </Menu>
  );
}

function ReceiveModal({ inst, provider, scope, onClose, invalidate }: { inst: Installment | null; provider: string; scope: ProviderScope; onClose: () => void; invalidate: string[][] }) {
  const [paidAt, setPaidAt] = useState(todayIso());
  const [amount, setAmount] = useState(0);
  useEffect(() => {
    if (inst) {
      setPaidAt(todayIso());
      setAmount(inst.amountCents);
    }
  }, [inst]);
  const save = useAction(() => api.post(`/finance/installments/${inst!.id}/receive`, { paidAt, paidAmountCents: amount }), {
    success: 'Recebimento registrado.',
    invalidate,
    onSuccess: onClose,
  });
  const future = paidAt > todayIso();
  return (
    <Modal
      open={Boolean(inst)}
      title={`Registrar recebimento — parcela ${inst?.number ?? ''}`}
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!paidAt || future || amount <= 0} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Confirmar recebimento
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <ScopeNotice scope={scope} provider={provider}>
          O recebimento também é registrado no {provider} ({provider === 'Omie' ? 'baixa da conta a receber' : 'recebimento em dinheiro'}): a cobrança deixa de aceitar pagamento.
        </ScopeNotice>
        <span className="vf-muted">
          Vencimento em {inst ? formatDate(inst.dueDate) : ''} · valor de {inst ? formatMoney(inst.amountCents) : ''}.
        </span>
        <div className="vf-grid" style={{ '--cols': 2 } as React.CSSProperties}>
          <Input label="Data do recebimento" type="date" required value={paidAt} max={todayIso()} onChange={(e) => setPaidAt(e.target.value)} error={future ? 'Não pode ser no futuro' : undefined} />
          <MoneyInput label="Valor recebido" required value={amount} onChange={setAmount} />
        </div>
      </div>
    </Modal>
  );
}

function EditInstallmentModal({ inst, provider, scope, onClose, invalidate }: { inst: Installment | null; provider: string; scope: ProviderScope; onClose: () => void; invalidate: string[][] }) {
  const [dueDate, setDueDate] = useState('');
  const [amount, setAmount] = useState(0);
  useEffect(() => {
    if (inst) {
      setDueDate(inst.dueDate);
      setAmount(inst.amountCents);
    }
  }, [inst]);
  const save = useAction(() => api.put(`/finance/installments/${inst!.id}`, { dueDate, amountCents: amount }), {
    success: 'Parcela atualizada.',
    invalidate,
    onSuccess: onClose,
  });
  const err = save.error instanceof ApiError ? save.error.message : null;
  return (
    <Modal
      open={Boolean(inst)}
      title={`Alterar parcela ${inst?.number ?? ''}`}
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!dueDate || amount <= 0} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <ScopeNotice scope={scope} provider={provider}>
          A cobrança no {provider} é atualizada com o novo vencimento e valor; o link de pagamento do cliente continua o mesmo.
        </ScopeNotice>
        <div className="vf-grid" style={{ '--cols': 2 } as React.CSSProperties}>
          <Input label="Vencimento" type="date" required value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          <MoneyInput label="Valor" required value={amount} onChange={setAmount} />
        </div>
        <span className="vf-text-xs vf-muted">O total do faturamento é recalculado com a soma das parcelas.</span>
        {err && <span className="vf-field__error">{err}</span>}
      </div>
    </Modal>
  );
}

function CancelInstallmentModal({
  inst,
  total,
  provider,
  scope,
  onClose,
  invalidate,
}: {
  inst: Installment | null;
  total: number;
  provider: string;
  scope: ProviderScope;
  onClose: () => void;
  invalidate: string[][];
}) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (inst) setReason('');
  }, [inst]);
  const cancel = useAction(() => api.post(`/finance/installments/${inst!.id}/cancel`, { reason: reason.trim() || undefined }), {
    success: 'Parcela cancelada.',
    invalidate,
    onSuccess: onClose,
  });
  return (
    <Modal
      open={Boolean(inst)}
      title={`Cancelar parcela ${inst?.number ?? ''}/${total}`}
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button kind="danger" loading={cancel.isPending} onClick={() => cancel.mutate(undefined)}>
            Cancelar parcela
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <span className="vf-muted">
          A parcela de {inst ? formatMoney(inst.amountCents) : ''} (vencimento em {inst ? formatDate(inst.dueDate) : ''}) deixa de ser cobrada e sai do total do faturamento. Não dá para desfazer.
        </span>
        <ScopeNotice scope={scope} provider={provider}>
          A cobrança também é cancelada no {provider}: o link de pagamento do cliente deixa de funcionar.
        </ScopeNotice>
        <Textarea label="Motivo (opcional)" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} />
      </div>
    </Modal>
  );
}
