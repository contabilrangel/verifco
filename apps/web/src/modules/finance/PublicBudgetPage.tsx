import { useState } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CheckCircle2, Clock, Mail, Phone, XCircle } from 'lucide-react';
import { Alert, Button, ConfirmDialog, Loading, Modal, Textarea } from '../../ds';
import { ApiError, api } from '../../lib/api';
import { formatDate, formatMoney, formatPhone } from '../../lib/format';
import type { PublicBudget } from './types';
import { formatNumber } from './ui';

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

/** Página pública (sem login) para o cliente aprovar ou recusar a proposta. */
export function PublicBudgetPage() {
  const { token = '' } = useParams();
  const qc = useQueryClient();
  const key = ['public-budget', token];
  const q = useQuery<PublicBudget, ApiError>({ queryKey: key, queryFn: () => api.get<PublicBudget>(`/public/budgets/${token}`, { token: '' }), retry: false });
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const decide = useMutation<{ budget: PublicBudget['budget'] }, ApiError, 'approve' | 'reject'>({
    mutationFn: (kind) => api.post(`/public/budgets/${token}/${kind}`, kind === 'reject' ? { reason } : {}, { token: '' }),
    onSuccess: (r) => {
      qc.setQueryData<PublicBudget>(key, (old) => (old ? { ...old, budget: r.budget } : old));
      setConfirmApprove(false);
      setRejecting(false);
    },
  });

  if (q.isLoading) {
    return (
      <PublicShell>
        <Loading label="Abrindo a proposta..." />
      </PublicShell>
    );
  }
  if (q.isError || !q.data) {
    const expired = q.error?.status === 410;
    return (
      <PublicShell>
        <div className="vf-fin-public__state">
          {expired ? <Clock /> : <XCircle />}
          <h1 className="vf-text-lg">{expired ? 'Link indisponível' : 'Proposta não encontrada'}</h1>
          <p className="vf-muted">{expired ? q.error?.message : 'Confira se o link foi copiado por completo ou peça ao escritório um novo envio.'}</p>
        </div>
      </PublicShell>
    );
  }

  const { office, customer, budget: b, expiresAt } = q.data;
  const plan = b.plan;
  const sameAmounts = new Set(b.installmentAmounts).size === 1;

  return (
    <PublicShell>
      <header className="vf-fin-public__head">
        {office.hasLogo ? (
          <img src={`${API_BASE}/api/public/budgets/${token}/logo`} alt={office.name} className="vf-fin-public__logo" />
        ) : (
          <span className="vf-fin-public__office">{office.name}</span>
        )}
        <span className="vf-text-xs vf-muted">Proposta de serviço · Imposto de Renda {b.exerciseYear}</span>
      </header>

      <div className="vf-stack" style={{ '--gap': '6px' } as React.CSSProperties}>
        <span className="vf-muted">Olá, {customer.name.split(' ')[0]}!</span>
        <h1 className="vf-text-xl">{b.categoryLabel}</h1>
        {b.description && <p style={{ whiteSpace: 'pre-wrap' }}>{b.description}</p>}
      </div>

      <div className="vf-fin-public__price">
        {b.discountPercent > 0 && (
          <div className="vf-inline vf-between vf-text-sm">
            <span className="vf-muted">Valor</span>
            <span>
              <s className="vf-muted">{formatMoney(b.amountCents)}</s> · desconto de {formatNumber(b.discountPercent)}%
            </span>
          </div>
        )}
        <div className="vf-inline vf-between" style={{ alignItems: 'baseline' }}>
          <span className="vf-text-sm-bold">Total</span>
          <span className="vf-fin-public__total">{formatMoney(b.totalCents)}</span>
        </div>
        <div className="vf-inline vf-between vf-text-sm">
          <span className="vf-muted">Pagamento</span>
          <span>
            {b.installments > 1 ? (sameAmounts ? `${b.installments}x de ${formatMoney(b.installmentAmounts[0])}` : `${b.installments} parcelas`) : 'À vista'}
            {b.paymentMethod ? ` · ${b.paymentMethod}` : ''}
          </span>
        </div>
        {plan && plan.length > 1 && (
          <ul className="vf-fin-public__plan">
            {plan.map((p) => (
              <li key={p.number}>
                <span>
                  {p.number}ª parcela · {formatDate(p.dueDate)}
                </span>
                <span>{formatMoney(p.amountCents)}</span>
              </li>
            ))}
          </ul>
        )}
        {plan && plan.length === 1 && (
          <div className="vf-inline vf-between vf-text-sm">
            <span className="vf-muted">Vencimento</span>
            <span>{formatDate(plan[0].dueDate)}</span>
          </div>
        )}
      </div>

      {b.status === 'approved' ? (
        <Alert tone="success" title="Proposta aprovada">
          Obrigado! {office.name} já foi avisado{b.approvedAt ? ` (aprovada em ${formatDate(b.approvedAt)})` : ''}. As cobranças seguem a forma de pagamento acima.
        </Alert>
      ) : b.status === 'rejected' ? (
        <Alert tone="warning" title="Proposta recusada">
          Avisamos o escritório. Se mudar de ideia, peça um novo envio da proposta.
        </Alert>
      ) : (
        <div className="vf-stack">
          {decide.error && <Alert tone="danger">{decide.error.message}</Alert>}
          <div className="vf-fin-public__actions">
            <Button kind="tertiary" onClick={() => setRejecting(true)}>
              Recusar
            </Button>
            <Button icon={<CheckCircle2 />} onClick={() => setConfirmApprove(true)}>
              Aprovar proposta
            </Button>
          </div>
          {expiresAt && (
            <span className="vf-text-xs vf-muted vf-inline" style={{ justifyContent: 'center', '--gap': '4px' } as React.CSSProperties}>
              <CalendarClock size={14} /> Link válido até {formatDate(expiresAt)}
            </span>
          )}
        </div>
      )}

      <footer className="vf-fin-public__foot">
        <span>
          Enviada por <strong>{office.name}</strong>
        </span>
        <span className="vf-inline" style={{ '--gap': '12px' } as React.CSSProperties}>
          {office.email && (
            <a href={`mailto:${office.email}`} className="vf-inline" style={{ '--gap': '4px' } as React.CSSProperties}>
              <Mail size={14} /> {office.email}
            </a>
          )}
          {office.phone && (
            <span className="vf-inline" style={{ '--gap': '4px' } as React.CSSProperties}>
              <Phone size={14} /> {formatPhone(office.phone)}
            </span>
          )}
        </span>
      </footer>

      <ConfirmDialog
        open={confirmApprove}
        title="Aprovar proposta"
        message={`Ao aprovar, você concorda com o valor de ${formatMoney(b.totalCents)}${b.installments > 1 ? ` em ${b.installments} parcelas` : ''} e o escritório pode iniciar o trabalho e as cobranças.`}
        confirmLabel="Aprovar"
        loading={decide.isPending}
        onConfirm={() => decide.mutate('approve')}
        onClose={() => setConfirmApprove(false)}
      />
      <Modal
        open={rejecting}
        title="Recusar proposta"
        onClose={() => setRejecting(false)}
        width={460}
        footer={
          <>
            <Button kind="secondary" onClick={() => setRejecting(false)}>
              Voltar
            </Button>
            <Button kind="danger" loading={decide.isPending} onClick={() => decide.mutate('reject')}>
              Recusar proposta
            </Button>
          </>
        }
      >
        <Textarea label="Quer contar o motivo? (opcional)" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} />
      </Modal>
    </PublicShell>
  );
}

function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="vf-fin-public">
      <main className="vf-fin-public__card">{children}</main>
      <span className="vf-fin-public__brand">
        Gestão de IRPF com <img src="/verifco-logo.svg" alt="Verifco" />
      </span>
    </div>
  );
}
