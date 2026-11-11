import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Download, FileText, Mail, MessageCircle, Save, Send } from 'lucide-react';
import { INDIVIDUAL_REPORTS, KIT_ATTACHMENTS_MAX_BYTES, formatFileSize, type IndividualReportKey } from '@verifco/shared';
import { Alert, Button, Card, Checkbox, ConfirmDialog, Loading, Modal, MoneyInput, Switch, Tag, useToast } from '../../ds';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { formatMoney, formatPhone, stageTone, substatusLabel } from '../../lib/format';
import { useYear } from '../../lib/year';
import { useCustomer } from '../customers/customerContext';
import './reports.css';

type OtherExpenses = { annualPaymentCents?: number; principalCents?: number; interestCents?: number; creditCardCents?: number; capitalLossCents?: number };

interface ReportsContext {
  declaration: { id: string; exerciseYear: number; stage: string; substatus: string; taxation: string | null; taxDueCents: number; refundCents: number; otherExpenses: OtherExpenses };
  customer: { id: string; name: string; email: string | null; mobile: string | null };
  itemsCount: number;
  itemsByKind: { kind: string; label: string; n: number }[];
  spouse: { available: boolean; reason: string; name: string | null };
  reports: { key: IndividualReportKey; label: string; description: string; allowed: boolean }[];
  hasLogo: boolean;
  canEditOtherExpenses: boolean;
  canSendKit: boolean;
}

const EXPENSE_FIELDS: { key: keyof OtherExpenses; label: string }[] = [
  { key: 'annualPaymentCents', label: 'Pagamento anual total' },
  { key: 'principalCents', label: 'Pagamento anual total — principal' },
  { key: 'interestCents', label: 'Pagamento anual total — juros' },
  { key: 'creditCardCents', label: 'Despesas com cartão de crédito' },
  { key: 'capitalLossCents', label: 'Perdas de capital' },
];

/** Etapa "Relatórios" da aba IRPF: outros gastos, relatórios individuais e kit pós-declaração. */
export function IrpfReportsStep() {
  const { customer } = useCustomer();
  const { year } = useYear();
  const resolved = useApi<{ declarationId: string }>(['reports', 'declaration', customer.id, year], `/reports/declaration?customerId=${customer.id}&year=${year}`);
  const id = resolved.data?.declarationId;
  const ctx = useApi<ReportsContext>(['reports', 'context', id], id ? `/declarations/${id}/reports` : null);
  if (resolved.error || ctx.error) return <Alert tone="danger">{(resolved.error ?? ctx.error)?.message ?? 'Não foi possível abrir os relatórios.'}</Alert>;
  if (!ctx.data) return <Loading />;
  return <ReportsStepContent ctx={ctx.data} />;
}

function ReportsStepContent({ ctx }: { ctx: ReportsContext }) {
  const { can } = useAuth();
  const toast = useToast();
  const d = ctx.declaration;
  const allowed = ctx.reports.filter((r) => r.allowed).map((r) => r.key);
  const [selected, setSelected] = useState<IndividualReportKey[]>(allowed.includes('cash_analysis') ? ['cash_analysis'] : allowed.slice(0, 1));
  const [format, setFormat] = useState<'pdf' | 'xlsx'>('pdf');
  const [spouse, setSpouse] = useState(false);
  const [expenses, setExpenses] = useState<OtherExpenses>(d.otherExpenses ?? {});
  const [sendTo, setSendTo] = useState<null | 'email' | 'whatsapp'>(null);
  const [requestId, setRequestId] = useState('');
  const [busy, setBusy] = useState(false);
  const [kitOpen, setKitOpen] = useState(false);
  useEffect(() => setExpenses(d.otherExpenses ?? {}), [d.otherExpenses]);

  const hasItems = ctx.itemsCount > 0;
  const body = { reports: INDIVIDUAL_REPORTS.map((r) => r.key).filter((k) => selected.includes(k)), format, includeSpouse: spouse && ctx.spouse.available };
  const dirtyExpenses = EXPENSE_FIELDS.some((f) => (expenses[f.key] ?? 0) !== (d.otherExpenses?.[f.key] ?? 0));

  const saveExpenses = useAction(() => api.put(`/declarations/${d.id}/other-expenses`, expenses), {
    success: 'Outros gastos salvos.',
    invalidate: [['reports', 'context', d.id]],
  });
  const send = useAction(() => api.post<{ queued: number; alreadyQueued: number }>(`/declarations/${d.id}/reports/send`, { ...body, channels: [sendTo], requestId }), {
    success: (r) => (r.queued ? 'Relatórios enviados para a fila de envio.' : 'Este envio já estava na fila.'),
    invalidate: [['deliveries']],
    onSuccess: () => setSendTo(null),
  });

  const generate = async () => {
    setBusy(true);
    try {
      await api.download(`/declarations/${d.id}/reports/generate`, `relatorios-irpf-${d.exerciseYear}.${format}`, body);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não foi possível gerar os relatórios.');
    } finally {
      setBusy(false);
    }
  };

  const ready = hasItems && body.reports.length > 0;
  const result = d.taxDueCents > 0 ? `A pagar ${formatMoney(d.taxDueCents)}` : d.refundCents > 0 ? `A restituir ${formatMoney(d.refundCents)}` : 'Sem saldo';
  const transmitted = ['transmitted', 'finished'].includes(d.stage);

  return (
    <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
      {!hasItems && (
        <Alert tone="warning" title={`A declaração ${d.exerciseYear} ainda não tem linhas cadastradas`}>
          Os relatórios usam os rendimentos, pagamentos, bens e dívidas da declaração. Antes de gerar, lance as linhas na etapa Declaração ou extraia-as do PDF da declaração na Elaboração (com IA). O arquivo do programa IRPF enviado pelo sincronizador fica só guardado: o conteúdo dele não é lido.
        </Alert>
      )}
      {!ctx.hasLogo && hasItems && (
        <Alert>
          Os relatórios saem com o nome do escritório. Para incluir o logo,{' '}
          {can('office.edit') ? <Link to="/admin/empresa">cadastre-o em Meu escritório › Empresa</Link> : 'peça ao administrador para cadastrá-lo'} (PNG ou JPG).
        </Alert>
      )}
      <div className="vf-grid" style={{ '--grid-template': 'minmax(0, 1.5fr) minmax(0, 1fr)', alignItems: 'start' } as React.CSSProperties}>
        <Card
          title="Relatórios"
          actions={
            allowed.length > 1 && (
              <Button size="sm" kind="tertiary" onClick={() => setSelected(selected.length === allowed.length ? [] : allowed)}>
                {selected.length === allowed.length ? 'Desmarcar todos' : 'Marcar todos'}
              </Button>
            )
          }
        >
          <div className="vf-stack">
            <div className="vf-stack" style={{ '--gap': '12px' } as React.CSSProperties}>
              {ctx.reports.map((r) => (
                <label key={r.key} className="vf-check" title={r.allowed ? undefined : 'Seu perfil não tem permissão para este relatório.'} style={r.allowed ? undefined : { opacity: 0.5, cursor: 'not-allowed' }}>
                  <input type="checkbox" disabled={!r.allowed} checked={selected.includes(r.key)} onChange={() => setSelected((s) => (s.includes(r.key) ? s.filter((x) => x !== r.key) : [...s, r.key]))} />
                  <span className="vf-stack" style={{ '--gap': '0px' } as React.CSSProperties}>
                    <span className="vf-text-sm-bold">
                      {r.label} {!r.allowed && <Tag>Sem permissão</Tag>}
                    </span>
                    <span className="vf-text-xs vf-muted">{r.description}</span>
                  </span>
                </label>
              ))}
            </div>
            <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 16 }} className="vf-stack">
              <span className="vf-text-sm-bold">Opções</span>
              <Switch label="Exibir dados do cônjuge" checked={spouse && ctx.spouse.available} disabled={!ctx.spouse.available} onChange={setSpouse} />
              <span className="vf-text-xs vf-muted" style={{ marginTop: -8 }}>
                {ctx.spouse.reason}
              </span>
              <span className="vf-text-sm-bold">Formato de saída</span>
              <div className="vf-inline" style={{ '--gap': '24px' } as React.CSSProperties}>
                <label className="vf-check">
                  <input type="radio" name="format" checked={format === 'pdf'} onChange={() => setFormat('pdf')} />
                  <span>PDF</span>
                </label>
                <label className="vf-check">
                  <input type="radio" name="format" checked={format === 'xlsx'} onChange={() => setFormat('xlsx')} />
                  <span>Excel</span>
                </label>
              </div>
            </div>
            <div className="vf-inline vf-between" style={{ borderTop: '1px solid var(--color-border)', paddingTop: 16 }}>
              <div className="vf-inline">
                <span className="vf-text-xs vf-muted">Enviar ao cliente:</span>
                <Button
                  size="sm"
                  kind="secondary"
                  icon={<Mail />}
                  disabled={!ready || !ctx.customer.email}
                  title={ctx.customer.email ? 'Enviar por e-mail' : 'O cliente não tem e-mail cadastrado.'}
                  onClick={() => {
                    setRequestId(crypto.randomUUID());
                    setSendTo('email');
                  }}
                >
                  E-mail
                </Button>
                <Button
                  size="sm"
                  kind="secondary"
                  icon={<MessageCircle />}
                  disabled={!ready || !ctx.customer.mobile}
                  title={ctx.customer.mobile ? 'Enviar por WhatsApp' : 'O cliente não tem celular cadastrado.'}
                  onClick={() => {
                    setRequestId(crypto.randomUUID());
                    setSendTo('whatsapp');
                  }}
                >
                  WhatsApp
                </Button>
              </div>
              <Button icon={<Download />} disabled={!ready} loading={busy} onClick={() => void generate()}>
                Gerar relatórios
              </Button>
            </div>
          </div>
        </Card>

        <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
          <Card title="Outros gastos">
            <div className="vf-stack">
              <span className="vf-text-xs vf-muted">Gastos que não aparecem nas fichas da declaração. Entram na análise de caixa como aplicações do ano.</span>
              {EXPENSE_FIELDS.map((f) => (
                <MoneyInput key={f.key} label={f.label} value={expenses[f.key] ?? 0} disabled={!ctx.canEditOtherExpenses} onChange={(c) => setExpenses((e) => ({ ...e, [f.key]: c }))} />
              ))}
              {ctx.canEditOtherExpenses && (
                <div className="vf-inline vf-end">
                  <Button icon={<Save />} disabled={!dirtyExpenses} loading={saveExpenses.isPending} onClick={() => saveExpenses.mutate(undefined)}>
                    Salvar
                  </Button>
                </div>
              )}
            </div>
          </Card>

          {(ctx.canSendKit || can('declaration.view')) && (
            <Card title="Kit pós-declaração">
              <div className="vf-stack">
                <div className="vf-inline">
                  <Tag tone={stageTone(d.stage)}>{substatusLabel(d.substatus)}</Tag>
                  <Tag tone={d.taxDueCents > 0 ? 'danger' : d.refundCents > 0 ? 'success' : 'neutral'}>{result}</Tag>
                </div>
                <span className="vf-text-xs vf-muted">
                  Resumo da declaração, quotas do DARF ou restituição, análise de caixa, evolução do patrimônio e lembretes para o próximo ano, em PDF. No envio, você escolhe os documentos da declaração que vão anexados no e-mail (recibo de entrega, declaração, guias DARF).
                </span>
                {!transmitted && <Alert tone="warning">O kit é enviado depois da transmissão. Você já pode baixar uma prévia.</Alert>}
                <div className="vf-inline">
                  <Button kind="secondary" icon={<FileText />} onClick={() => void api.open(`/declarations/${d.id}/kit.pdf`).catch((e: Error) => toast.error(e.message))}>
                    Baixar PDF
                  </Button>
                  {ctx.canSendKit && (
                    <Button icon={<Send />} disabled={!transmitted} onClick={() => setKitOpen(true)}>
                      Enviar ao cliente
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          )}

          {hasItems && (
            <Card title="Linhas cadastradas">
              <div className="vf-inline">
                {ctx.itemsByKind.map((k) => (
                  <Tag key={k.kind}>
                    {k.label}: {k.n}
                  </Tag>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>

      {kitOpen && <KitSendModal declarationId={d.id} customer={ctx.customer} onClose={() => setKitOpen(false)} />}

      <ConfirmDialog
        open={sendTo !== null}
        title={sendTo === 'whatsapp' ? 'Enviar por WhatsApp' : 'Enviar por e-mail'}
        confirmLabel="Enviar"
        loading={send.isPending}
        onConfirm={() => send.mutate(undefined)}
        onClose={() => setSendTo(null)}
        message={
          <span>
            {body.reports.length} relatório(s) em {format === 'pdf' ? 'PDF' : 'Excel'} vão para <strong>{ctx.customer.name}</strong>
            {sendTo === 'email' ? ` (${ctx.customer.email})` : ctx.customer.mobile ? ` (${formatPhone(ctx.customer.mobile)})` : ''}, com o template Documento para o cliente.
            {body.includeSpouse && ' Inclui os dados do cônjuge.'}
          </span>
        }
      />
    </div>
  );
}

interface KitAttachmentOption {
  fileId: string;
  source: 'document' | 'darf' | 'export';
  label: string;
  filename: string;
  size: number;
  suggested: boolean;
}

/**
 * Envio do kit a um cliente: canais e documentos da declaração que vão anexados no e-mail, junto
 * com o resumo em PDF. O recibo, a declaração do programa IRPF e as guias DARF em aberto vêm marcados.
 */
export function KitSendModal({ declarationId, customer, onClose }: { declarationId: string; customer: ReportsContext['customer']; onClose: () => void }) {
  const list = useApi<{ options: KitAttachmentOption[]; maxBytes: number }>(['reports', 'kit-attachments', declarationId], `/declarations/${declarationId}/kit/attachments`);
  const [email, setEmail] = useState(Boolean(customer.email));
  const [whatsapp, setWhatsapp] = useState(false);
  // a escolha começa pelos sugeridos assim que a lista chega; depois é do usuário
  const [picked, setPicked] = useState<string[] | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const options = list.data?.options ?? [];
  const maxBytes = list.data?.maxBytes ?? KIT_ATTACHMENTS_MAX_BYTES;
  const selected = picked ?? options.filter((o) => o.suggested).map((o) => o.fileId);
  const byEmail = email && Boolean(customer.email);
  const byWhatsapp = whatsapp && Boolean(customer.mobile);
  const attachmentIds = byEmail ? options.filter((o) => selected.includes(o.fileId)).map((o) => o.fileId) : [];
  const totalBytes = options.filter((o) => attachmentIds.includes(o.fileId)).reduce((a, o) => a + o.size, 0);
  const tooBig = totalBytes > maxBytes;
  const channels = [...(byEmail ? ['email'] : []), ...(byWhatsapp ? ['whatsapp'] : [])];
  const toggle = (id: string) => setPicked(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const send = useAction(() => api.post<{ queued: number; alreadyQueued: number }>(`/declarations/${declarationId}/kit/send`, { channels, attachmentIds, requestId }), {
    success: (r) => (r.queued ? 'Kit enviado para a fila de envio.' : 'Este envio já estava na fila.'),
    invalidate: [['deliveries']],
    onSuccess: onClose,
  });

  return (
    <Modal
      open
      title="Enviar kit pós-declaração"
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button icon={<Send />} disabled={!channels.length || tooBig || list.isLoading} loading={send.isPending} onClick={() => send.mutate(undefined)}>
            Enviar
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <span>
          O resumo do kit em PDF vai para <strong>{customer.name}</strong>, com o template Documento para o cliente.
        </span>
        <Checkbox label={customer.email ? `Por e-mail (${customer.email})` : 'Por e-mail (cliente sem e-mail cadastrado)'} checked={byEmail} disabled={!customer.email} onChange={(e) => setEmail(e.target.checked)} />
        <Checkbox
          label={customer.mobile ? `Por WhatsApp (${formatPhone(customer.mobile)})` : 'Por WhatsApp (cliente sem celular cadastrado)'}
          checked={byWhatsapp}
          disabled={!customer.mobile}
          onChange={(e) => setWhatsapp(e.target.checked)}
        />
        <span className="vf-text-sm-bold">Documentos anexos no e-mail</span>
        {list.error ? (
          <Alert tone="danger">{list.error.message || 'Não foi possível listar os documentos da declaração.'}</Alert>
        ) : list.isLoading ? (
          <Loading />
        ) : options.length === 0 ? (
          <span className="vf-text-xs vf-muted">Esta declaração não tem recibo, declaração, DARF nem outros documentos guardados como arquivo. O kit vai só com o resumo.</span>
        ) : (
          <>
            <div className="vf-rep-attachments" role="group" aria-label="Documentos anexos no e-mail">
              {options.map((o) => (
                <Checkbox
                  key={o.fileId}
                  checked={byEmail && selected.includes(o.fileId)}
                  disabled={!byEmail}
                  onChange={() => toggle(o.fileId)}
                  label={
                    <>
                      {o.label}
                      <span className="vf-rep-attachments__file">
                        {o.filename} · {formatFileSize(o.size)}
                      </span>
                    </>
                  }
                />
              ))}
            </div>
            <span className="vf-text-xs vf-muted">
              {attachmentIds.length === 0 ? 'Nenhum anexo escolhido' : `${attachmentIds.length} anexo(s) · ${formatFileSize(totalBytes)}`}. Limite de {formatFileSize(maxBytes)} por e-mail, contando o resumo em PDF.
            </span>
          </>
        )}
        {tooBig && (
          <Alert tone="danger">
            Os anexos escolhidos somam {formatFileSize(totalBytes)} e passam do limite de {formatFileSize(maxBytes)} do e-mail. Desmarque algum anexo.
          </Alert>
        )}
        {byWhatsapp && options.length > 0 && <Alert>Pelo WhatsApp vai só o resumo em PDF. Os documentos anexos vão no e-mail.</Alert>}
      </div>
    </Modal>
  );
}
