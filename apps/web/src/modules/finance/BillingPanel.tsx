import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, FileText, Mail, MessageCircle, MoreHorizontal, Pencil, Undo2 } from 'lucide-react';
import { todayIso } from '@verifco/shared';
import { Alert, Button, ConfirmDialog, IconButton, Input, Menu, MenuItem, Modal, MoneyInput, Stat } from '../../ds';
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
  | { kind: 'send'; inst: Installment; channel: 'email' | 'whatsapp' }
  | null;

const PROVIDERS: Record<string, string> = { asaas: 'Asaas', omie: 'Omie' };

export function BillingPanel({ billing, customerId, contact }: { billing: Billing; customerId: string; contact: { email: boolean; mobile: boolean } }) {
  const { can } = useAuth();
  const [dialog, setDialog] = useState<Dialog>(null);
  const invalidate = [['finance', 'budgets', customerId]];
  const close = () => setDialog(null);

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
  const openReceipt = async (inst: Installment) => {
    if (inst.receiptFileId) await api.open(`/files/${inst.receiptFileId}?inline=1`);
  };

  const total = billing.installments.length;
  return (
    <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
      <div className="vf-fin-stats">
        <Stat label="Faturado" value={formatMoney(billing.totalCents)} hint={`${total} parcela(s)${billing.provider ? ` · ${PROVIDERS[billing.provider] ?? billing.provider}` : ''}`} />
        <Stat label="Recebido" value={formatMoney(billing.paidCents)} tone={billing.paidCents > 0 ? 'success' : undefined} />
        <Stat label="Em aberto" value={formatMoney(billing.openCents)} />
        <Stat label="Vencido" value={formatMoney(billing.overdueCents)} tone={billing.overdueCents > 0 ? 'danger' : undefined} />
      </div>
      {billing.provider && billing.installments.every((i) => !i.externalUrl) && (
        <Alert tone="primary">A cobrança está sendo emitida no {PROVIDERS[billing.provider] ?? billing.provider}. Os links de pagamento aparecem aqui assim que ficarem prontos.</Alert>
      )}
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
                      {i.externalUrl && (
                        <a href={i.externalUrl} target="_blank" rel="noreferrer" className="vf-text-xs vf-inline" style={{ '--gap': '4px' } as React.CSSProperties}>
                          <ExternalLink size={12} /> Boleto / Pix
                        </a>
                      )}
                    </div>
                  </td>
                  <td className="num">{formatMoney(i.amountCents)}</td>
                  <td>
                    <InstallmentStatusTag status={i.status} />
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

      <ReceiveModal inst={dialog?.kind === 'receive' ? dialog.inst : null} onClose={close} invalidate={invalidate} />
      <EditInstallmentModal inst={dialog?.kind === 'edit' ? dialog.inst : null} onClose={close} invalidate={invalidate} />
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
        open={dialog?.kind === 'reopen'}
        title="Desfazer recebimento"
        message="A parcela volta a ficar em aberto. Use quando o recebimento foi lançado por engano."
        confirmLabel="Desfazer"
        danger
        loading={reopen.isPending}
        onConfirm={() => dialog?.kind === 'reopen' && reopen.mutate(dialog.inst)}
        onClose={close}
      />
    </div>
  );
}

function InstallmentMenu({ inst, onPick, contact }: { inst: Installment; onPick: (d: Dialog) => void; contact: { email: boolean; mobile: boolean } }) {
  const { can } = useAuth();
  const open = inst.status === 'open' || inst.status === 'overdue';
  const paid = inst.status === 'paid';
  const items = [
    open && can('billing.edit'),
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
        </>
      )}
    </Menu>
  );
}

function ReceiveModal({ inst, onClose, invalidate }: { inst: Installment | null; onClose: () => void; invalidate: string[][] }) {
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

function EditInstallmentModal({ inst, onClose, invalidate }: { inst: Installment | null; onClose: () => void; invalidate: string[][] }) {
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
        {inst?.externalId && <Alert tone="warning">Esta parcela já tem cobrança emitida no provedor. O valor só pode ser alterado por lá.</Alert>}
        <div className="vf-grid" style={{ '--cols': 2 } as React.CSSProperties}>
          <Input label="Vencimento" type="date" required value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          <MoneyInput label="Valor" required value={amount} onChange={setAmount} disabled={Boolean(inst?.externalId)} />
        </div>
        <span className="vf-text-xs vf-muted">O total do faturamento é recalculado com a soma das parcelas.</span>
        {err && <span className="vf-field__error">{err}</span>}
      </div>
    </Modal>
  );
}
