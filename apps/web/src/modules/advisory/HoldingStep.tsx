import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Building2, FileDown, ListChecks, Save } from 'lucide-react';
import type { HoldingSimulationParams, HoldingSimulationResult } from '@verifco/shared';
import { Alert, Button, Card, Checkbox, EmptyState, Loading, Modal, MoneyInput, Select, Switch, Tag, useToast } from '../../ds';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { formatDateTime, formatMoney } from '../../lib/format';
import { useYear } from '../../lib/year';
import { useCustomer } from '../customers/customerContext';
import { Kpi, SimulationNotice, errorMessage, pct } from './ui';

interface Property {
  id: string;
  description: string;
  code: string | null;
  prevValueCents: number;
  declaredValueCents: number;
  marketValueCents: number;
  monthlyRentCents: number;
  selected: boolean;
}
interface HoldingPayload {
  year: number;
  hasDeclaration: boolean;
  saved: boolean;
  updatedAt: string | null;
  properties: Property[];
  params: HoldingSimulationParams;
  otherTaxableIncomeCents: number;
  declaredTotalCents: number;
  result: HoldingSimulationResult;
}

function PercentInput({ label, value, onChange, help, step = 0.1 }: { label: string; value: number; onChange: (v: number) => void; help?: string; step?: number }) {
  return (
    <label className="vf-field">
      <span className="vf-field__label">{label}</span>
      <div className="vf-input-group">
        <input className="vf-input" style={{ paddingLeft: 12, paddingRight: 32 }} type="number" min={0} max={100} step={step} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="vf-input-group__suffix">%</span>
      </div>
      {help && <span className="vf-field__help">{help}</span>}
    </label>
  );
}

export function HoldingStep() {
  const { customer } = useCustomer();
  const { year } = useYear();
  const toast = useToast();
  const qc = useQueryClient();
  const key = ['holding', customer.id, year];
  const q = useApi<HoldingPayload>(key, `/customers/${customer.id}/holding?year=${year}`);
  const [params, setParams] = useState<HoldingSimulationParams | null>(null);
  const [props, setProps] = useState<Property[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [manage, setManage] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);

  useEffect(() => {
    if (q.data) {
      setParams(q.data.params);
      setProps(q.data.properties);
      setDirty(false);
    }
  }, [q.data]);

  const set = <K extends keyof HoldingSimulationParams>(k: K, v: HoldingSimulationParams[K]) => {
    setParams((p) => (p ? { ...p, [k]: v } : p));
    setDirty(true);
  };
  const setProp = (id: string, patch: Partial<Property>) => {
    setProps((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    setDirty(true);
  };

  const save = async () => {
    if (!params) return;
    setSaving(true);
    try {
      const res = await api.put<HoldingPayload>(`/customers/${customer.id}/holding`, {
        year,
        selectedItemIds: props.filter((p) => p.selected).map((p) => p.id),
        params,
        properties: Object.fromEntries(props.map((p) => [p.id, { monthlyRentCents: p.monthlyRentCents, marketValueCents: p.marketValueCents }])),
      });
      qc.setQueryData(key, res);
      toast.success('Simulação salva e recalculada.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const pdf = async () => {
    setPdfBusy(true);
    try {
      if (dirty) await save();
      await api.download(`/customers/${customer.id}/holding/pdf`, `holding-${year}.pdf`, { year });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPdfBusy(false);
    }
  };

  const used = useMemo(() => props.filter((p) => p.selected), [props]);
  if (q.isLoading || !params) return q.error ? <Alert tone="danger">{errorMessage(q.error)}</Alert> : <Loading />;
  const data = q.data!;
  const r = data.result;

  if (!data.properties.length) {
    return (
      <Card>
        <EmptyState
          icon={<Building2 />}
          title="Nenhum imóvel na declaração"
          description={`A simulação usa os bens do grupo 01 (imóveis) da declaração de ${year}. Lance os bens na etapa Declaração para simular a holding.`}
        />
      </Card>
    );
  }

  return (
    <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
      <Card
        title={
          <span className="vf-inline">
            <Building2 size={20} /> Holding
            {dirty ? <Tag tone="warning">Alterações não salvas</Tag> : data.saved ? <Tag>Salva em {formatDateTime(data.updatedAt)}</Tag> : <Tag>Simulação padrão</Tag>}
          </span>
        }
        actions={
          <>
            <Button kind="secondary" size="sm" icon={<ListChecks />} onClick={() => setManage(true)}>
              Gerenciar bens
            </Button>
            <Button kind="secondary" size="sm" icon={<FileDown />} loading={pdfBusy} onClick={() => void pdf()}>
              Gerar PDF
            </Button>
            <Button size="sm" icon={<Save />} loading={saving} disabled={!dirty} onClick={() => void save()}>
              Salvar e recalcular
            </Button>
          </>
        }
      >
        <div className="vf-stack">
          <p className="vf-muted">
            Bens da simulação: <strong>{used.length}</strong> de {props.length} imóveis utilizados no cálculo.
          </p>
          <div className="vf-kpis">
            <Kpi label="Patrimônio declarado" value={formatMoney(r.totals.declaredValueCents)} hint={`Mercado ${formatMoney(r.totals.marketValueCents)}`} />
            <Kpi label="Aluguel mensal" value={formatMoney(r.totals.monthlyRentCents)} hint={`${formatMoney(r.totals.annualRentCents)} por ano`} />
            <Kpi label="ITBI na integralização" value={formatMoney(r.rows.find((x) => x.key === 'itbi')!.holdingCents)} hint={r.params.itbiImmune ? 'Com imunidade' : `${r.params.itbiPercent}% do valor de mercado`} />
            <Kpi
              label={`Economia estimada (${r.params.years} anos + sucessão)`}
              value={<span className={r.totalSavingCents >= 0 ? 'vf-saving' : 'vf-loss'}>{formatMoney(r.totalSavingCents)}</span>}
              hint={r.totalSavingCents >= 0 ? 'A holding custa menos' : 'Manter na PF custa menos'}
              strong
            />
          </div>
        </div>
      </Card>

      <Card title="Parâmetros da simulação">
        <div className="vf-grid" style={{ '--cols': 4 } as React.CSSProperties}>
          <PercentInput label="ITBI do município" value={params.itbiPercent} onChange={(v) => set('itbiPercent', v)} help="Sobre o valor de mercado" />
          <PercentInput label="Cartório e registro" value={params.registryPercent} onChange={(v) => set('registryPercent', v)} help="Emolumentos estimados" />
          <PercentInput label="ITCMD do estado" value={params.itcmdPercent} onChange={(v) => set('itcmdPercent', v)} />
          <PercentInput label="Honorários e custas do inventário" value={params.inventoryFeesPercent} onChange={(v) => set('inventoryFeesPercent', v)} />
          <MoneyInput label="Constituição da holding" value={params.holdingSetupCents} onChange={(v) => set('holdingSetupCents', v)} help="Honorários, contrato social e Junta" />
          <MoneyInput label="Manutenção anual da holding" value={params.holdingAnnualCostCents} onChange={(v) => set('holdingAnnualCostCents', v)} help="Contabilidade e taxas" />
          <PercentInput label="Reajuste anual dos aluguéis" value={params.rentGrowthPercent} onChange={(v) => set('rentGrowthPercent', v)} step={0.5} />
          <Select
            label="Horizonte da projeção"
            value={String(params.years)}
            onChange={(e) => set('years', Number(e.target.value))}
            options={[5, 10, 15, 20].map((n) => ({ value: String(n), label: `${n} anos` }))}
          />
          <Select
            label="Base do ITCMD na holding"
            value={params.holdingItcmdBase}
            onChange={(e) => set('holdingItcmdBase', e.target.value as 'market' | 'declared')}
            options={[
              { value: 'market', label: 'Valor de mercado das quotas (LC 227/2026)' },
              { value: 'declared', label: 'Valor declarado (lei estadual antiga)' },
            ]}
            style={{ gridColumn: 'span 2' }}
          />
          <div className="vf-field" style={{ gridColumn: 'span 2', justifyContent: 'flex-end' }}>
            <Switch label="Aplicar imunidade de ITBI na integralização (CF, art. 156, § 2º, I)" checked={params.itbiImmune} onChange={(v) => set('itbiImmune', v)} />
          </div>
        </div>
        <p className="vf-muted vf-text-xs" style={{ marginTop: 12 }}>
          Demais rendimentos tributáveis do cliente (sem aluguéis): {formatMoney(data.otherTaxableIncomeCents)} — usados para calcular o IR marginal dos aluguéis na pessoa física.
        </p>
      </Card>

      <Card flush title="Comparação de custos" actions={dirty ? <Tag tone="warning">Salve para recalcular</Tag> : undefined}>
        <div className="vf-table-wrap" style={{ marginTop: 16 }}>
          <table className="vf-table">
            <thead>
              <tr>
                <th></th>
                <th>PF ou qualquer PJ</th>
                <th className="num">Valor</th>
                <th>Holding</th>
                <th className="num">Valor</th>
                <th className="num">Economia</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((x) => (
                <tr key={x.key} className={x.key === 'ten_years' ? 'tot' : undefined}>
                  <td className="vf-text-sm-bold">{x.label}</td>
                  <td className="vf-muted vf-text-xs">{x.pfLabel}</td>
                  <td className="num">{formatMoney(x.pfCents)}</td>
                  <td className="vf-muted vf-text-xs">{x.holdingLabel}</td>
                  <td className="num">{formatMoney(x.holdingCents)}</td>
                  <td className={`num ${x.savingCents >= 0 ? 'vf-saving' : 'vf-loss'}`}>{formatMoney(x.savingCents)}</td>
                </tr>
              ))}
              <tr className="tot">
                <td colSpan={2}>Total ({r.params.years} anos + sucessão)</td>
                <td className="num">{formatMoney(r.pfTotalCents)}</td>
                <td></td>
                <td className="num">{formatMoney(r.holdingTotalCents)}</td>
                <td className={`num ${r.totalSavingCents >= 0 ? 'vf-saving' : 'vf-loss'}`}>{formatMoney(r.totalSavingCents)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="vf-muted vf-text-xs" style={{ padding: '12px 24px 20px' }}>
          IR anual na holding: IRPJ {formatMoney(r.holdingRentTax.irpjCents)} + adicional {formatMoney(r.holdingRentTax.surchargeCents)} + CSLL {formatMoney(r.holdingRentTax.csllCents)} + PIS/COFINS{' '}
          {formatMoney(r.holdingRentTax.pisCofinsCents)} sobre lucro presumido de {formatMoney(r.holdingRentTax.presumedProfitCents)}. Na PF, o aluguel tem carga efetiva de {pct(r.pfRentEffectiveRatePercent)}. A venda
          hipotética não entra no total (os imóveis não podem ser vendidos e herdados ao mesmo tempo).
        </p>
      </Card>

      <Card title={<span className="vf-inline"><AlertTriangle size={18} color="var(--color-warning)" /> Observações importantes</span>}>
        <div className="vf-stack" style={{ '--gap': '8px' } as React.CSSProperties}>
          {r.warnings.map((w) => (
            <Alert key={w} tone="warning">
              {w}
            </Alert>
          ))}
          <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {r.observations.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
          <SimulationNotice>Parâmetros federais com fonte em: {r.taxParams.sources.map((s) => s.split(':')[0]).join('; ')}.</SimulationNotice>
        </div>
      </Card>

      <Modal
        open={manage}
        title="Gerenciar bens"
        width={860}
        onClose={() => setManage(false)}
        footer={
          <>
            <Button kind="secondary" onClick={() => setManage(false)}>
              Fechar
            </Button>
            <Button
              icon={<Save />}
              loading={saving}
              onClick={async () => {
                await save();
                setManage(false);
              }}
            >
              Salvar e recalcular
            </Button>
          </>
        }
      >
        <div className="vf-stack">
          <p className="vf-muted">
            {used.length} de {props.length} imóveis utilizados no cálculo. Informe o valor de mercado (base do ITBI, do ITCMD e da venda) e o aluguel mensal de cada imóvel.
          </p>
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Usar</th>
                  <th>Imóvel</th>
                  <th className="num">Declarado</th>
                  <th style={{ width: 170 }}>Valor de mercado</th>
                  <th style={{ width: 150 }}>Aluguel mensal</th>
                </tr>
              </thead>
              <tbody>
                {props.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Checkbox label="" aria-label={`Usar ${p.description}`} checked={p.selected} onChange={() => setProp(p.id, { selected: !p.selected })} />
                    </td>
                    <td>
                      <span className="vf-text-sm-bold">{p.description}</span>
                      {p.code && <span className="vf-text-xs vf-muted"> · código {p.code}</span>}
                    </td>
                    <td className="num">{formatMoney(p.declaredValueCents)}</td>
                    <td>
                      <MoneyInput aria-label="Valor de mercado" value={p.marketValueCents} onChange={(v) => setProp(p.id, { marketValueCents: v })} />
                    </td>
                    <td>
                      <MoneyInput aria-label="Aluguel mensal" value={p.monthlyRentCents} onChange={(v) => setProp(p.id, { monthlyRentCents: v })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Modal>
    </div>
  );
}
