import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Calculator, Download, Printer, SlidersHorizontal } from 'lucide-react';
import { IRPFM_INCOME_GROUPS, type IrpfmResult, type NominalRateKind } from '@verifco/shared';
import { Alert, Button, Card, Drawer, Loading, Modal, MoneyInput, Select, Tag, useToast } from '../../ds';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatCpfCnpj, formatMoney } from '../../lib/format';
import { useYear } from '../../lib/year';
import { useCustomer } from '../customers/customerContext';
import { AiBadge, ChatPanel, Kpi, SimulationNotice, errorMessage, fetchBlob, pct, printBlob } from './ui';

interface Payer {
  payerDoc?: string | null;
  payerName?: string | null;
  pjEffectiveRatePercent?: number | null;
  nominalKind?: NominalRateKind;
}
interface Adjustments {
  regularTaxDueCents?: number | null;
  law14754TaxCents?: number | null;
  definitiveTaxPaidCents?: number | null;
  dividendWithholdingCents?: number | null;
  dividendPayers?: Payer[];
}
interface IrpfmPayload {
  year: number;
  calendarYear: number;
  hasDeclaration: boolean;
  itemsCount: number;
  regularTaxSource: 'declaration' | 'estimated' | 'manual';
  regularTaxSourceLabel: string;
  result: IrpfmResult;
}

const NOMINAL_OPTIONS = [
  { value: 'general', label: '34% — demais empresas' },
  { value: 'insuranceFinancial', label: '40% — seguradoras e financeiras' },
  { value: 'banks', label: '45% — bancos' },
];

const SHORTCUTS = ['Estou sujeito ao IRPFM?', 'Calcular IRPFM', 'O que entra na base?', 'Parecer para o contador'];

export function IrpfmTab() {
  const { customer } = useCustomer();
  const { year } = useYear();
  const { can } = useAuth();
  const toast = useToast();
  const [adj, setAdj] = useState<Adjustments>({});
  const [showDetail, setShowDetail] = useState(false);
  const [showAdj, setShowAdj] = useState(false);
  const [busy, setBusy] = useState<'pdf' | 'print' | null>(null);
  const q = useQuery({
    queryKey: ['irpfm', customer.id, year, adj],
    queryFn: () => api.post<IrpfmPayload>(`/customers/${customer.id}/irpfm`, { year, adjustments: adj }),
  });

  const pdf = async (mode: 'pdf' | 'print') => {
    setBusy(mode);
    try {
      const blob = await fetchBlob(`/customers/${customer.id}/irpfm/pdf`, { year, adjustments: adj });
      if (mode === 'print') printBlob(blob);
      else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `irpfm-${year}.pdf`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const data = q.data;
  const r = data?.result;
  return (
    <div className="vf-split">
      <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
        <Card
          title={
            <span className="vf-inline">
              <Calculator size={20} /> Situação IRPFM {year}
            </span>
          }
          actions={
            r && (
              <>
                <Button kind="secondary" size="sm" icon={<SlidersHorizontal />} onClick={() => setShowAdj(true)}>
                  Ajustes do cálculo
                </Button>
                <Button size="sm" onClick={() => setShowDetail(true)}>
                  Ver cálculo detalhado
                </Button>
              </>
            )
          }
        >
          {q.isLoading || !data || !r ? (
            q.error ? <Alert tone="danger">{errorMessage(q.error)}</Alert> : <Loading />
          ) : (
            <div className="vf-stack">
              <div className="vf-inline">
                <span className="vf-muted vf-text-sm">Ano-calendário {year - 1}</span>
                <Tag tone={r.subject ? (r.dueCents > 0 ? 'danger' : 'warning') : 'success'}>{r.subject ? 'Sujeito à tributação mínima' : 'Não sujeito ao IRPFM'}</Tag>
                {!r.inForce && <Tag tone="highlight">Simulação (lei vale a partir de 2026)</Tag>}
                {(adj.regularTaxDueCents ?? null) !== null || adj.dividendPayers?.length ? <Tag tone="primary">Com ajustes do escritório</Tag> : null}
              </div>
              {!data.hasDeclaration || !data.itemsCount ? (
                <Alert tone="primary" title="Sem linhas da declaração neste exercício">
                  Lance ou importe a declaração de {year} para que os rendimentos entrem no cálculo.
                </Alert>
              ) : null}
              <div className="vf-adv-kpis">
                <Kpi label="Rendimentos considerados" value={formatMoney(r.totalIncomeCents)} hint={`Limite ${formatMoney(r.thresholdCents)}`} />
                <Kpi label="Base de cálculo" value={formatMoney(r.baseCents)} hint={`Exclusões ${formatMoney(r.exclusionsCents)}`} />
                <Kpi label="Excesso sobre o limite" value={formatMoney(r.excessCents)} hint={`Alíquota mínima ${pct(r.ratePercent)}`} />
                <Kpi label="Imposto bruto" value={formatMoney(r.grossTaxCents)} />
                <Kpi label="Imposto já pago" value={formatMoney(r.deductions.totalCents)} hint={r.reducer.totalCents ? `+ redutor ${formatMoney(r.reducer.totalCents)}` : data.regularTaxSourceLabel} />
                <Kpi label="IRPFM devido" value={formatMoney(r.dueCents)} />
                <Kpi label="Imposto complementar" value={formatMoney(r.complementaryCents)} hint={r.dividendWithholdingCents ? `Após retenção de ${formatMoney(r.dividendWithholdingCents)}` : undefined} strong />
                <Kpi label="Alíquota efetiva" value={pct(r.effectiveRatePercent)} hint="Imposto total ÷ base" />
              </div>
              <Alert tone={r.dueCents > 0 ? 'warning' : 'success'}>{r.conclusion}</Alert>
              {r.warnings.map((w) => (
                <Alert key={w} tone="warning">
                  {w}
                </Alert>
              ))}
              <SimulationNotice>
                Lei 15.270/2025 (arts. 6º-A, 16-A e 16-B da Lei 9.250/1995). O IR devido na declaração foi {data.regularTaxSourceLabel}; ajuste em “Ajustes do cálculo”.
              </SimulationNotice>
            </div>
          )}
        </Card>
      </div>

      {can('ai.use') && (
        <Card className="vf-ai-card" title={<span className="vf-inline">Assistente IRPFM <AiBadge /></span>}>
          <ChatPanel
            customerId={customer.id}
            assistant="irpfm"
            year={year}
            shortcuts={SHORTCUTS}
            height={380}
            intro="Tire dúvidas sobre a tributação mínima deste cliente. O assistente recebe o resumo da declaração e o cálculo do IRPFM."
          />
        </Card>
      )}

      {r && data && (
        <Modal
          open={showDetail}
          title="Cálculo do IRPFM"
          onClose={() => setShowDetail(false)}
          width={920}
          footer={
            <>
              <Button kind="secondary" icon={<Printer />} loading={busy === 'print'} onClick={() => void pdf('print')}>
                Imprimir
              </Button>
              <Button icon={<Download />} loading={busy === 'pdf'} onClick={() => void pdf('pdf')}>
                Download
              </Button>
            </>
          }
        >
          <IrpfmDetail r={r} data={data} customerName={customer.name} cpf={customer.cpfCnpj} />
        </Modal>
      )}

      {r && showAdj && (
        <AdjustmentsDrawer
          open
          result={r}
          current={adj}
          onClose={() => setShowAdj(false)}
          onApply={(a) => {
            setAdj(a);
            setShowAdj(false);
          }}
        />
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="vf-stack" style={{ '--gap': '8px' } as React.CSSProperties}>
      <h3 className="vf-text-md-bold">{title}</h3>
      {children}
    </section>
  );
}

function MoneyTable({ rows, total }: { rows: { label: string; cents: number; sub?: boolean }[]; total?: { label: string; cents: number } }) {
  return (
    <div className="vf-table-wrap">
      <table className="vf-table">
        <thead>
          <tr>
            <th>Descrição</th>
            <th className="num">Valores</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((x, i) => (
            <tr key={i} className={x.sub ? 'sub' : undefined}>
              <td>{x.label}</td>
              <td className="num">{formatMoney(x.cents)}</td>
            </tr>
          ))}
          {total && (
            <tr className="tot">
              <td>{total.label}</td>
              <td className="num">{formatMoney(total.cents)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function IrpfmDetail({ r, data, customerName, cpf }: { r: IrpfmResult; data: IrpfmPayload; customerName: string; cpf: string }) {
  const comp = r.composition.filter((c) => c.group !== 'excluded');
  return (
    <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>
      <Section title="Resumo">
        <p className="vf-muted">
          {customerName} · CPF {formatCpfCnpj(cpf)} · exercício {data.year} (ano-calendário {data.calendarYear})
        </p>
        <MoneyTable
          rows={[
            { label: 'Rendimentos totais no ano', cents: r.totalIncomeCents },
            { label: 'Limite de sujeição', cents: r.thresholdCents },
            { label: 'Base de cálculo', cents: r.baseCents },
            { label: 'IRPFM devido', cents: r.dueCents },
          ]}
          total={{ label: 'Imposto complementar', cents: r.complementaryCents }}
        />
      </Section>
      <Section title="Composição dos rendimentos">
        {comp.length ? (
          <MoneyTable rows={comp.flatMap((c) => [{ label: IRPFM_INCOME_GROUPS[c.group], cents: c.cents }, ...c.lines.map((l) => ({ label: l.label, cents: l.cents, sub: true }))])} total={{ label: 'Total na base', cents: r.baseCents }} />
        ) : (
          <p className="vf-muted">Nenhum rendimento na base.</p>
        )}
      </Section>
      <Section title="Exclusões">
        {r.exclusions.length ? (
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Descrição</th>
                  <th>Observações</th>
                  <th className="num">Valores</th>
                </tr>
              </thead>
              <tbody>
                {r.exclusions.map((e) => (
                  <tr key={e.exclusion}>
                    <td>{e.label}</td>
                    <td className="vf-muted">{e.ref}</td>
                    <td className="num">{formatMoney(e.cents)}</td>
                  </tr>
                ))}
                <tr className="tot">
                  <td colSpan={2}>Total excluído</td>
                  <td className="num">{formatMoney(r.exclusionsCents)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <p className="vf-muted">Nenhum rendimento excluído da base.</p>
        )}
      </Section>
      <Section title="Base de cálculo">
        <MoneyTable rows={[{ label: 'Rendimentos totais', cents: r.totalIncomeCents }, { label: '(−) Exclusões', cents: -r.exclusionsCents }]} total={{ label: 'Base de cálculo', cents: r.baseCents }} />
      </Section>
      <Section title="Alíquota">
        <p>
          {r.baseCents >= r.params.fullRateFromCents
            ? `Base a partir de ${formatMoney(r.params.fullRateFromCents)}: alíquota de 10%.`
            : r.baseCents > r.thresholdCents
              ? `Alíquota % = REND / 60.000 − 10 = ${(r.baseCents / 100).toLocaleString('pt-BR')} / 60.000 − 10 = ${pct(r.ratePercent, 4)}.`
              : 'Base até R$ 600.000,00: alíquota zero.'}
        </p>
      </Section>
      <Section title="Imposto bruto">
        <MoneyTable rows={[{ label: `${pct(r.ratePercent, 4)} × ${formatMoney(r.baseCents)}`, cents: r.grossTaxCents }]} />
      </Section>
      <Section title="Deduções">
        <MoneyTable
          rows={[
            { label: `I — IR devido na declaração de ajuste (${data.regularTaxSourceLabel})`, cents: r.deductions.regularTaxDueCents },
            { label: 'II — IR retido exclusivamente na fonte', cents: r.deductions.exclusiveWithheldCents },
            { label: 'III — IR da Lei 14.754/2023 (exterior)', cents: r.deductions.law14754TaxCents },
            { label: 'IV — IR pago definitivamente (ex.: renda variável)', cents: r.deductions.definitiveTaxPaidCents },
          ]}
          total={{ label: 'Total das deduções', cents: r.deductions.totalCents }}
        />
      </Section>
      <Section title="Redutor (art. 16-B)">
        {r.reducer.payers.length ? (
          <>
            <p className="vf-muted">Alíquota efetiva da tributação mínima da PF sobre os dividendos: {pct(r.reducer.pfEffectiveRatePercent)}.</p>
            <div className="vf-table-wrap">
              <table className="vf-table">
                <thead>
                  <tr>
                    <th>Empresa pagadora</th>
                    <th className="num">Dividendos</th>
                    <th className="num">Efetiva PJ</th>
                    <th className="num">Nominal</th>
                    <th className="num">Redutor</th>
                  </tr>
                </thead>
                <tbody>
                  {r.reducer.payers.map((p, i) => (
                    <tr key={i}>
                      <td>{p.payerName || (p.payerDoc ? formatCpfCnpj(p.payerDoc) : 'Não identificada')}</td>
                      <td className="num">{formatMoney(p.dividendsCents)}</td>
                      <td className="num">{p.pjEffectiveRatePercent === null ? <span className="vf-muted">não informada</span> : pct(p.pjEffectiveRatePercent)}</td>
                      <td className="num">{pct(p.nominalRatePercent, 0)}</td>
                      <td className="num">{formatMoney(p.reducerCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="vf-muted">Sem lucros e dividendos na base: não há redutor.</p>
        )}
      </Section>
      <Section title="Imposto complementar">
        <MoneyTable
          rows={[
            { label: 'Imposto bruto', cents: r.grossTaxCents },
            { label: '(−) Deduções', cents: -r.deductions.totalCents },
            { label: '(−) Redutor', cents: -r.reducer.totalCents },
            { label: 'IRPFM devido (não negativo)', cents: r.dueCents },
            { label: '(−) IR retido sobre dividendos (art. 6º-A)', cents: -r.dividendWithholdingCents },
          ]}
          total={{ label: 'Valor somado ao saldo da declaração', cents: r.complementaryCents }}
        />
      </Section>
      <Section title="Conclusão">
        <Alert tone={r.dueCents > 0 ? 'warning' : 'success'}>{r.conclusion}</Alert>
        <SimulationNotice />
      </Section>
    </div>
  );
}

function AdjustmentsDrawer({
  open,
  result,
  current,
  onClose,
  onApply,
}: {
  open: boolean;
  result: IrpfmResult;
  current: Adjustments;
  onClose: () => void;
  onApply: (a: Adjustments) => void;
}) {
  const [regular, setRegular] = useState<number | null>(current.regularTaxDueCents ?? null);
  const [law, setLaw] = useState<number | null>(current.law14754TaxCents ?? null);
  const [definitive, setDefinitive] = useState<number | null>(current.definitiveTaxPaidCents ?? null);
  const [withholding, setWithholding] = useState<number | null>(current.dividendWithholdingCents ?? null);
  const [payers, setPayers] = useState<Payer[]>(() =>
    result.reducer.payers.map((p) => {
      const cur = current.dividendPayers?.find((c) => (c.payerDoc ?? c.payerName) === (p.payerDoc ?? p.payerName));
      return { payerDoc: p.payerDoc, payerName: p.payerName, pjEffectiveRatePercent: cur?.pjEffectiveRatePercent ?? p.pjEffectiveRatePercent, nominalKind: cur?.nominalKind ?? 'general' };
    }),
  );
  return (
    <Drawer
      open={open}
      title="Ajustes do cálculo"
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button kind="secondary" onClick={() => onApply({})}>
            Usar dados da declaração
          </Button>
          <Button
            onClick={() =>
              onApply({ regularTaxDueCents: regular, law14754TaxCents: law, definitiveTaxPaidCents: definitive, dividendWithholdingCents: withholding, dividendPayers: payers })
            }
          >
            Recalcular
          </Button>
        </>
      }
    >
      <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
        <p className="vf-muted">Valores em branco usam o que está na declaração. Os ajustes valem para esta tela e para o PDF.</p>
        <MoneyInput label="IR devido na declaração de ajuste" help={`Calculado: ${formatMoney(result.deductions.regularTaxDueCents)}`} value={regular} onChange={setRegular} />
        <MoneyInput label="IR da Lei 14.754/2023 (aplicações no exterior)" value={law} onChange={setLaw} />
        <MoneyInput label="IR pago definitivamente (renda variável etc.)" value={definitive} onChange={setDefinitive} />
        <MoneyInput label="IR retido sobre dividendos (art. 6º-A)" value={withholding} onChange={setWithholding} />
        <h3 className="vf-text-md-bold">Redutor: empresas pagadoras de dividendos</h3>
        {payers.length === 0 ? (
          <p className="vf-muted">Não há dividendos na base de cálculo.</p>
        ) : (
          payers.map((p, i) => (
            <div key={i} className="vf-stack" style={{ '--gap': '8px', padding: 12, border: '1px solid var(--color-border)', borderRadius: 8 } as React.CSSProperties}>
              <strong>{p.payerName || (p.payerDoc ? formatCpfCnpj(p.payerDoc) : 'Empresa não identificada')}</strong>
              <div className="vf-grid">
                <label className="vf-field">
                  <span className="vf-field__label">Alíquota efetiva da PJ (%)</span>
                  <input
                    className="vf-input"
                    type="number"
                    min={0}
                    max={100}
                    step={0.01}
                    value={p.pjEffectiveRatePercent ?? ''}
                    onChange={(e) => setPayers((list) => list.map((x, j) => (j === i ? { ...x, pjEffectiveRatePercent: e.target.value === '' ? null : Number(e.target.value) } : x)))}
                  />
                  <span className="vf-field__help">IRPJ + CSLL devidos ÷ lucro contábil</span>
                </label>
                <Select
                  label="Percentual nominal"
                  value={p.nominalKind ?? 'general'}
                  options={NOMINAL_OPTIONS}
                  onChange={(e) => setPayers((list) => list.map((x, j) => (j === i ? { ...x, nominalKind: e.target.value as NominalRateKind } : x)))}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </Drawer>
  );
}
