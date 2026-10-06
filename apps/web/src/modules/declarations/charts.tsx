/**
 * Gráficos do Verifco em SVG próprio (sem biblioteca): barras, rosca e barra empilhada.
 *
 * Regras seguidas (paleta validada para CVD e contraste na superfície branca):
 * - cor por entidade, em ordem fixa: azul, verde, âmbar, roxo, vermelho; cinza para
 *   "não informado/não iniciado". Texto nunca usa a cor da série;
 * - marcas finas (barras de 12px com ponta arredondada de 4px), 2px de folga entre fatias;
 * - valores sempre visíveis (legenda/rótulo) e uma visão em tabela para cada gráfico;
 * - dica (tooltip) no passar do mouse e no foco do teclado.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { BarChart3, Table2 } from 'lucide-react';
import { Card, EmptyState } from '../../ds';

export const SERIES = ['var(--chart-1)', 'var(--chart-2)', 'var(--color-yellow-80)', 'var(--chart-4)', 'var(--chart-5)'];
export const NEUTRAL = 'var(--chart-7)';

export interface Datum {
  key: string;
  label: string;
  value: number;
  /** Texto exibido para o valor (ex.: moeda); padrão: número formatado. */
  display?: string;
  /** Linha secundária na tabela/dica (ex.: quantidade quando o valor é dinheiro). */
  detail?: string;
  color?: string;
}

const fmtInt = (n: number) => n.toLocaleString('pt-BR');
const pct = (v: number, total: number) => (total > 0 ? `${((v / total) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '0%');
const shown = (d: Datum) => d.display ?? fmtInt(d.value);

/** Largura do contêiner (para desenhar o SVG em pixels reais). */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

type Tip = { x: number; y: number; d: Datum; total: number } | null;

function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return (
    <div className="vf-chart__tooltip" style={{ left: tip.x, top: tip.y }} role="status">
      <strong>{shown(tip.d)}</strong>
      <span>
        {tip.d.label} · {pct(tip.d.value, tip.total)}
      </span>
      {tip.d.detail && <span>{tip.d.detail}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- barras horizontais
/** Lista de barras: um rótulo por linha, valor à direita e barra fina embaixo. */
export function BarList({ data, color = SERIES[0], ariaLabel, onSelect }: { data: Datum[]; color?: string; ariaLabel: string; onSelect?: (d: Datum) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const [active, setActive] = useState<string | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((a, d) => a + d.value, 0);
  const row = 40;
  const bar = 12;
  const height = data.length * row;
  return (
    <div ref={ref} className="vf-chart">
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          <title>{ariaLabel}</title>
          {data.map((d, i) => {
            const y = i * row;
            const w = d.value > 0 ? Math.max(4, (d.value / max) * width) : 0;
            const focus = () => {
              setActive(d.key);
              setTip({ x: Math.min(Math.max(w, 60), width - 60), y: y + 18, d, total });
            };
            const blur = () => {
              setActive(null);
              setTip(null);
            };
            return (
              <g
                key={d.key}
                tabIndex={0}
                role="listitem"
                aria-label={`${d.label}: ${shown(d)}`}
                onPointerEnter={focus}
                onPointerLeave={blur}
                onFocus={focus}
                onBlur={blur}
                onClick={onSelect ? () => onSelect(d) : undefined}
                style={{ cursor: onSelect ? 'pointer' : 'default', outline: 'none' }}
              >
                <rect x={0} y={y} width={width} height={row} fill="transparent" />
                <text x={0} y={y + 14} className="vf-chart__label">
                  {d.label}
                </text>
                <text x={width} y={y + 14} textAnchor="end" className="vf-chart__value">
                  {shown(d)}
                </text>
                <rect x={0} y={y + 22} width={width} height={bar} rx={4} className="vf-chart__track" />
                {w > 0 && <path d={barPath(0, y + 22, w, bar, 4)} fill={d.color ?? color} opacity={active && active !== d.key ? 0.55 : 1} />}
              </g>
            );
          })}
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

/** Barra com a ponta (lado do dado) arredondada e a base reta. */
function barPath(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  return `M${x},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} H${x} Z`;
}

// ---------------------------------------------------------------- rosca
export function Donut({ data, ariaLabel, centerLabel, centerValue }: { data: Datum[]; ariaLabel: string; centerLabel: string; centerValue?: string }) {
  const [tip, setTip] = useState<Tip>(null);
  const [active, setActive] = useState<string | null>(null);
  const size = 168;
  const R = size / 2;
  const r = R - 22;
  const total = data.reduce((a, d) => a + d.value, 0);
  const colored = data.map((d, i) => ({ ...d, color: d.color ?? SERIES[i % SERIES.length] }));
  let angle = -Math.PI / 2;
  const arcs = colored
    .filter((d) => d.value > 0)
    .map((d) => {
      const a0 = angle;
      const a1 = angle + (d.value / total) * Math.PI * 2;
      angle = a1;
      return { d, a0, a1 };
    });
  return (
    <div className="vf-donut">
      <div className="vf-chart" style={{ width: size, height: size, flexShrink: 0 }}>
        <svg width={size} height={size} role="img" aria-label={ariaLabel}>
          <title>{ariaLabel}</title>
          {total === 0 && <circle cx={R} cy={R} r={(R + r) / 2} fill="none" strokeWidth={R - r} className="vf-chart__track-stroke" />}
          {arcs.map(({ d, a0, a1 }) => {
            const mid = (a0 + a1) / 2;
            const show = () => {
              setActive(d.key);
              setTip({ x: R + Math.cos(mid) * (R - 11), y: R + Math.sin(mid) * (R - 11), d, total });
            };
            const hide = () => {
              setActive(null);
              setTip(null);
            };
            return (
              <path
                key={d.key}
                d={arcPath(R, R, R, r, a0, a1)}
                fill={d.color}
                stroke="var(--color-surface)"
                strokeWidth={2}
                opacity={active && active !== d.key ? 0.55 : 1}
                tabIndex={0}
                aria-label={`${d.label}: ${shown(d)} (${pct(d.value, total)})`}
                onPointerEnter={show}
                onPointerLeave={hide}
                onFocus={show}
                onBlur={hide}
                style={{ outline: 'none' }}
              />
            );
          })}
          <text x={R} y={R - 2} textAnchor="middle" className="vf-chart__center">
            {centerValue ?? fmtInt(total)}
          </text>
          <text x={R} y={R + 16} textAnchor="middle" className="vf-chart__center-label">
            {centerLabel}
          </text>
        </svg>
        <Tooltip tip={tip} />
      </div>
      <Legend items={colored} total={total} active={active} onHover={setActive} />
    </div>
  );
}

function arcPath(cx: number, cy: number, R: number, r: number, a0: number, a1: number): string {
  // fatia única (100%): dois semicírculos para fechar o anel
  if (a1 - a0 >= Math.PI * 2 - 1e-6) {
    return `${arcPath(cx, cy, R, r, a0, a0 + Math.PI)} ${arcPath(cx, cy, R, r, a0 + Math.PI, a1)}`;
  }
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (rad: number, a: number) => `${cx + Math.cos(a) * rad},${cy + Math.sin(a) * rad}`;
  return `M${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${large} 0 ${p(r, a0)} Z`;
}

function Legend({ items, total, active, onHover }: { items: Datum[]; total: number; active?: string | null; onHover?: (k: string | null) => void }) {
  return (
    <ul className="vf-legend">
      {items.map((d) => (
        <li
          key={d.key}
          className="vf-legend__item"
          style={{ opacity: active && active !== d.key ? 0.6 : 1 } as CSSProperties}
          onPointerEnter={() => onHover?.(d.key)}
          onPointerLeave={() => onHover?.(null)}
        >
          <span className="vf-legend__swatch" style={{ background: d.color }} aria-hidden />
          <span className="vf-legend__label">{d.label}</span>
          <span className="vf-legend__value">{shown(d)}</span>
          <span className="vf-legend__pct">{pct(d.value, total)}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- barra empilhada (parte do todo)
export function StackedBar({ data, ariaLabel }: { data: Datum[]; ariaLabel: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const [active, setActive] = useState<string | null>(null);
  const total = data.reduce((a, d) => a + d.value, 0);
  const colored = data.map((d, i) => ({ ...d, color: d.color ?? SERIES[i % SERIES.length] }));
  const h = 24;
  const gap = 2;
  const visible = colored.filter((d) => d.value > 0);
  const usable = Math.max(0, width - gap * Math.max(0, visible.length - 1));
  let x = 0;
  return (
    <div className="vf-stack" style={{ '--gap': '16px' } as CSSProperties}>
      <div ref={ref} className="vf-chart">
        {width > 0 && (
          <svg width={width} height={h} role="img" aria-label={ariaLabel}>
            <title>{ariaLabel}</title>
            <defs>
              <clipPath id={`clip-${ariaLabel.replace(/\W/g, '')}`}>
                <rect x={0} y={0} width={width} height={h} rx={4} />
              </clipPath>
            </defs>
            {total === 0 && <rect x={0} y={0} width={width} height={h} rx={4} className="vf-chart__track" />}
            <g clipPath={`url(#clip-${ariaLabel.replace(/\W/g, '')})`}>
              {visible.map((d) => {
                const w = Math.max(2, (d.value / total) * usable);
                const x0 = x;
                x += w + gap;
                const show = () => {
                  setActive(d.key);
                  setTip({ x: Math.min(Math.max(x0 + w / 2, 70), width - 70), y: 0, d, total });
                };
                const hide = () => {
                  setActive(null);
                  setTip(null);
                };
                return (
                  <rect
                    key={d.key}
                    x={x0}
                    y={0}
                    width={w}
                    height={h}
                    fill={d.color}
                    opacity={active && active !== d.key ? 0.55 : 1}
                    tabIndex={0}
                    aria-label={`${d.label}: ${shown(d)} (${pct(d.value, total)})`}
                    onPointerEnter={show}
                    onPointerLeave={hide}
                    onFocus={show}
                    onBlur={hide}
                    style={{ outline: 'none' }}
                  />
                );
              })}
            </g>
          </svg>
        )}
        <Tooltip tip={tip} />
      </div>
      <Legend items={colored} total={total} active={active} onHover={setActive} />
    </div>
  );
}

// ---------------------------------------------------------------- tabela e cartão
export function DataTable({ data, valueHeader = 'Quantidade', detailHeader }: { data: Datum[]; valueHeader?: string; detailHeader?: string }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  return (
    <div className="vf-table-wrap">
      <table className="vf-table">
        <thead>
          <tr>
            <th>Categoria</th>
            <th className="num">{valueHeader}</th>
            {detailHeader && <th className="num">{detailHeader}</th>}
            <th className="num">%</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.key}>
              <td>{d.label}</td>
              <td className="num">{shown(d)}</td>
              {detailHeader && <td className="num">{d.detail ?? ''}</td>}
              <td className="num">{pct(d.value, total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Cartão de gráfico com alternância entre gráfico e tabela. */
export function ChartCard({
  title,
  subtitle,
  data,
  empty,
  chart,
  valueHeader,
  detailHeader,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  data: Datum[];
  empty?: string;
  chart: ReactNode;
  valueHeader?: string;
  detailHeader?: string;
  footer?: ReactNode;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const hasData = data.some((d) => d.value > 0);
  return (
    <Card
      className="vf-chart-card"
      title={
        <span className="vf-stack" style={{ '--gap': '2px' } as CSSProperties}>
          <span>{title}</span>
          {subtitle && <span className="vf-text-xs vf-muted" style={{ fontWeight: 500 }}>{subtitle}</span>}
        </span>
      }
      actions={
        hasData && (
          <div className="vf-segmented" role="group" aria-label={`Visualização de ${title}`}>
            <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')} title="Gráfico">
              <BarChart3 aria-hidden />
              <span className="sr-only">Gráfico</span>
            </button>
            <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')} title="Tabela">
              <Table2 aria-hidden />
              <span className="sr-only">Tabela</span>
            </button>
          </div>
        )
      }
    >
      {!hasData ? (
        <EmptyState title="Sem dados ainda" description={empty ?? 'Os números aparecem aqui conforme a carteira for preenchida.'} />
      ) : view === 'chart' ? (
        chart
      ) : (
        <DataTable data={data} valueHeader={valueHeader} detailHeader={detailHeader} />
      )}
      {footer && <div className="vf-chart-card__footer">{footer}</div>}
    </Card>
  );
}
