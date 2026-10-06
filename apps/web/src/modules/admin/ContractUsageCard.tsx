import { CONTRACT_EXPIRING_DAYS, quotaLevel, type ContractUsage, type ContractUsageExercise } from '@verifco/shared';
import { Alert, Card, Progress, Stat, Tag } from '../../ds';
import { useApi } from '../../lib/hooks';
import { formatDate } from '../../lib/format';

const n = (v: number) => v.toLocaleString('pt-BR');
const declarations = (v: number) => `${n(v)} ${v === 1 ? 'declaração' : 'declarações'}`;

/** Uso do limite de um exercício: barra, contagem e aviso perto do limite (80%) ou no limite. */
function ExerciseUsage({ e, readOnly }: { e: ContractUsageExercise; readOnly: boolean }) {
  const level = quotaLevel(e);
  const title = `Declarações do exercício ${e.year}`;
  return (
    <div className="vf-stack" style={{ '--gap': '6px' } as React.CSSProperties}>
      <div className="vf-inline">
        <span className="vf-text-sm-bold vf-grow">{title}</span>
        {level === 'near' && <Tag tone="warning">Perto do limite</Tag>}
        {level === 'full' && <Tag tone="danger">Limite atingido</Tag>}
        <span className="vf-text-sm vf-mono">
          {e.limit === null ? (readOnly ? declarations(e.used) : `${declarations(e.used)} (sem limite)`) : `${n(e.used)} de ${n(e.limit)} (${e.percent}%)`}
        </span>
      </div>
      {e.limit !== null && <Progress value={e.percent ?? 0} tone={level === 'full' ? 'danger' : level === 'near' ? 'warning' : undefined} label={title} />}
      {level === 'full' ? (
        <Alert tone="danger">
          Não é possível criar novas declarações do exercício {e.year}: o pacote permite {declarations(e.limit ?? 0)}. As declarações já criadas continuam editáveis. Para ampliar o
          limite, fale com o suporte do Verifco.
        </Alert>
      ) : level === 'near' ? (
        <Alert tone="warning">
          {e.remaining === 1 ? 'Resta 1 declaração' : `Restam ${declarations(e.remaining ?? 0)}`} no pacote do exercício {e.year}. Para ampliar o limite, fale com o suporte do Verifco.
        </Alert>
      ) : (
        level === 'ok' && <span className="vf-text-xs vf-muted">{e.remaining === 1 ? 'Resta 1 declaração' : `Restam ${declarations(e.remaining ?? 0)}`} no pacote.</span>
      )}
    </div>
  );
}

/** Conteúdo do card (separado da consulta para os testes). */
export function ContractUsageView({ usage: u }: { usage: ContractUsage }) {
  const firstStart = u.active.map((c) => c.startsAt).sort()[0];
  const expiring = !u.readOnly && u.daysLeft !== null && u.daysLeft <= CONTRACT_EXPIRING_DAYS;
  return (
    <Card title="Uso do contrato">
      <div className="vf-stack">
        {u.readOnly ? (
          <Alert tone="danger" title="Nenhum contrato vigente">
            O escritório está só em consulta: as alterações ficam bloqueadas até a renovação.
            {u.nextStartsAt ? ` O próximo pacote começa em ${formatDate(u.nextStartsAt)}.` : u.lastExpiredAt ? ` O último pacote venceu em ${formatDate(u.lastExpiredAt)}.` : ''} Para renovar, fale
            com o suporte do Verifco.
          </Alert>
        ) : (
          expiring && (
            <Alert tone="warning" title={u.daysLeft! <= 0 ? 'O contrato vence hoje' : `O contrato vence em ${u.daysLeft === 1 ? '1 dia' : `${n(u.daysLeft!)} dias`}`}>
              {u.nextStartsAt
                ? `O próximo pacote começa em ${formatDate(u.nextStartsAt)}.`
                : 'Depois do vencimento, o escritório fica só em consulta até a renovação. Para renovar, fale com o suporte do Verifco.'}
            </Alert>
          )
        )}
        {!u.readOnly && u.validUntil && (
          <div className="vf-grid" style={{ '--cols': 3 } as React.CSSProperties}>
            <div className="adm-stat-box">
              <Stat label="Vigência" value={`${formatDate(firstStart)} a ${formatDate(u.validUntil)}`} hint={u.active.length === 1 ? '1 pacote vigente' : `${u.active.length} pacotes vigentes`} />
            </div>
            <div className="adm-stat-box">
              <Stat label="Dias restantes" value={u.daysLeft! <= 0 ? 'Vence hoje' : n(u.daysLeft!)} hint={`Até ${formatDate(u.validUntil)}`} tone={expiring ? 'danger' : undefined} />
            </div>
            <div className="adm-stat-box">
              <Stat label="Pacotes" value={u.active.map((c) => c.name).join(', ')} hint={`Exercício ${[...new Set(u.active.map((c) => c.year))].sort((a, b) => b - a).join(', ')}`} />
            </div>
          </div>
        )}
        {u.exercises.map((e) => (
          <ExerciseUsage key={e.year} e={e} readOnly={u.readOnly} />
        ))}
        <span className="vf-text-xs vf-muted">
          Contam as declarações do exercício de clientes não excluídos. Declarações de exercícios sem pacote vigente, como retificar um ano anterior, não consomem o limite.
        </span>
      </div>
    </Card>
  );
}

/** Uso do contrato do escritório: validade, modo só consulta e declarações usadas no limite (services/plan.ts). */
export function ContractUsageCard() {
  const q = useApi<ContractUsage>(['contracts', 'status'], '/office/contracts/status');
  // sem placeholder enquanto carrega: escritório sem contrato não mostra o card
  if (q.isError) return <Alert tone="danger" title="Não foi possível carregar o uso do contrato." />;
  if (!q.data?.hasContracts) return null;
  return <ContractUsageView usage={q.data} />;
}
