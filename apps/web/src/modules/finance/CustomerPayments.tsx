import { ExternalLink } from 'lucide-react';
import { formatDate, formatMoney } from '../../lib/format';
import type { CustomerPayment } from './types';
import { InstallmentStatusTag } from './ui';

/**
 * Parcelas dos honorários como o cliente vê (link da proposta e portal): vencimento, valor,
 * situação e o botão "Pagar", que abre o boleto/Pix do provedor em outra aba. Sem link, avisa que
 * o escritório vai enviar a cobrança.
 */
export function CustomerPayments({ payments }: { payments: CustomerPayment[] }) {
  const single = payments.length === 1;
  return (
    <ul className="vf-fin-payments">
      {payments.map((p) => {
        const open = p.status === 'open' || p.status === 'overdue';
        return (
          <li key={p.number}>
            <div className="vf-fin-payments__info">
              <span className="vf-text-sm-bold">
                {single ? 'Pagamento' : `${p.number}ª parcela`} · {formatMoney(p.amountCents)}
              </span>
              <span className="vf-muted vf-text-xs">{p.status === 'paid' && p.paidAt ? `Paga em ${formatDate(p.paidAt)}` : `Vencimento em ${formatDate(p.dueDate)}`}</span>
            </div>
            <div className="vf-fin-payments__side">
              <InstallmentStatusTag status={p.status} />
              {open &&
                (p.payUrl ? (
                  <a className="vf-btn vf-btn--sm" href={p.payUrl} target="_blank" rel="noopener noreferrer" aria-label={single ? 'Pagar' : `Pagar a ${p.number}ª parcela`}>
                    <ExternalLink />
                    Pagar
                  </a>
                ) : (
                  <span className="vf-muted vf-text-xs">O escritório vai enviar a cobrança</span>
                ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
