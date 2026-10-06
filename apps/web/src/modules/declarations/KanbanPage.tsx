import { useEffect, useMemo, useState, type CSSProperties, type DragEvent } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Columns3, FileWarning, RefreshCw, Search } from 'lucide-react';
import { DECLARATION_STAGES, DECLARATION_SUBSTATUS, STAGE_SUBSTATUS, stageOfSubstatus, type DeclarationStage, type DeclarationSubstatus } from '@verifco/shared';
import { Alert, Button, ConfirmDialog, EmptyState, IconButton, Input, Loading, Modal, Select, Tag, useToast } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { ApiError, api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useApi, useDebounced } from '../../lib/hooks';
import { formatCpfCnpj, formatMoney, stageLabel, stageTone, substatusLabel } from '../../lib/format';
import { YEAR_OPTIONS, useYear } from '../../lib/year';
import { NEUTRAL, SERIES } from './charts';
import type { Declaration } from './data';
import './declarations.css';

interface KanbanCard {
  customerId: string;
  name: string;
  cpfCnpj: string;
  email: string | null;
  responsibleName: string | null;
  groups: { id: string; name: string }[];
  declarationId: string | null;
  stage: DeclarationStage;
  substatus: DeclarationSubstatus;
  ecacStatus: string | null;
  taxDueCents: number;
  refundCents: number;
  openBacklogs: number;
}

interface KanbanColumn {
  stage: DeclarationStage;
  label: string;
  total: number;
  offset: number;
  cards: KanbanCard[];
}

interface KanbanData {
  year: number;
  stageLimit: number;
  total: number;
  columns: KanbanColumn[];
}

const STAGE_LIMIT = 50;
const STAGE_COLOR: Record<DeclarationStage, string> = { not_started: NEUTRAL, negotiation: SERIES[3], filling: SERIES[2], transmitted: SERIES[0], finished: SERIES[1] };

type MoveRequest = { card: KanbanCard; stage: DeclarationStage | null };

export function KanbanPage() {
  const { can } = useAuth();
  const { year, setYear } = useYear();
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [group, setGroup] = useState('');
  const [extra, setExtra] = useState<Partial<Record<DeclarationStage, KanbanCard[]>>>({});
  const [loadingMore, setLoadingMore] = useState<DeclarationStage | null>(null);
  const [dragging, setDragging] = useState<KanbanCard | null>(null);
  const [over, setOver] = useState<DeclarationStage | null>(null);
  const [move, setMove] = useState<MoveRequest | null>(null);
  const [confirmFinish, setConfirmFinish] = useState<KanbanCard | null>(null);
  const [moving, setMoving] = useState(false);

  const query = qs({ year, search: debounced, groups: group, stageLimit: STAGE_LIMIT });
  const k = useApi<KanbanData>(['kanban', query], `/kanban${query}`);
  const groups = useApi<{ id: string; name: string }[]>(['customer-groups'], '/customer-groups');
  const canEdit = can('declaration.edit');

  useEffect(() => setExtra({}), [k.dataUpdatedAt]);

  const columns = useMemo(
    () => (k.data?.columns ?? []).map((c) => ({ ...c, cards: [...c.cards, ...(extra[c.stage] ?? [])] })),
    [k.data, extra],
  );

  const loadMore = async (col: KanbanColumn) => {
    setLoadingMore(col.stage);
    try {
      const res = await api.get<KanbanData>(`/kanban${qs({ year, search: debounced, groups: group, stageLimit: STAGE_LIMIT, stage: col.stage, offset: col.cards.length })}`);
      setExtra((e) => ({ ...e, [col.stage]: [...(e[col.stage] ?? []), ...(res.columns[0]?.cards ?? [])] }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível carregar mais clientes.');
    } finally {
      setLoadingMore(null);
    }
  };

  /** Cria a declaração se preciso e muda o subestado. */
  const applyMove = async (card: KanbanCard, substatus: DeclarationSubstatus) => {
    setMoving(true);
    try {
      let id = card.declarationId;
      if (!id) id = (await api.put<Declaration>(`/customers/${card.customerId}/declarations/${year}`, {})).id;
      await api.patch(`/declarations/${id}/substatus`, { substatus });
      toast.success(`${card.name}: ${substatusLabel(substatus)}.`);
      setMove(null);
      setConfirmFinish(null);
      void qc.invalidateQueries({ queryKey: ['kanban'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      void qc.invalidateQueries({ queryKey: ['declaration', card.customerId] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível mover o cliente.');
    } finally {
      setMoving(false);
    }
  };

  const requestMove = (card: KanbanCard, stage: DeclarationStage) => {
    if (stage === card.stage) return;
    if (stage === 'finished' && !can('declaration.finish')) {
      toast.error('Seu perfil não pode finalizar declarações.');
      return;
    }
    const options = STAGE_SUBSTATUS[stage];
    if (options.length > 1) setMove({ card, stage });
    else if (stage === 'finished') setConfirmFinish(card);
    else void applyMove(card, options[0]);
  };

  const onDrop = (e: DragEvent, stage: DeclarationStage) => {
    e.preventDefault();
    setOver(null);
    const card = dragging;
    setDragging(null);
    if (card) requestMove(card, stage);
  };

  return (
    <>
      <PageHeader
        title="Kanban"
        description="Acompanhe a declaração de cada cliente no exercício. Arraste os cartões entre as etapas para atualizar o status."
        crumbs={[{ label: 'Início', to: '/' }, { label: 'Kanban' }]}
        actions={
          <Button kind="secondary" icon={<RefreshCw />} loading={k.isFetching && !k.isLoading} onClick={() => void k.refetch()}>
            Atualizar
          </Button>
        }
      />

      <div className="vf-kanban-toolbar" role="search">
        <div style={{ flex: '1 1 280px', maxWidth: 420 }}>
          <Input label="Buscar cliente" placeholder="Nome, CPF ou e-mail" icon={<Search />} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select
          label="Grupo de clientes"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          style={{ minWidth: 220 }}
          options={[{ value: '', label: 'Todos os grupos' }, { value: 'none', label: 'Sem grupo' }, ...(groups.data ?? []).map((g) => ({ value: g.id, label: g.name }))]}
        />
        <Select label="Ano-exercício" value={String(year)} onChange={(e) => setYear(Number(e.target.value))} options={YEAR_OPTIONS} style={{ minWidth: 160 }} />
        {k.data && (
          <span className="vf-muted vf-text-sm" style={{ paddingBottom: 10 }}>
            {k.data.total.toLocaleString('pt-BR')} cliente(s)
          </span>
        )}
      </div>

      {!canEdit && (
        <div style={{ marginBottom: 16 }}>
          <Alert>Você pode consultar o Kanban, mas seu perfil não altera o status das declarações.</Alert>
        </div>
      )}

      {k.isLoading ? (
        <Loading />
      ) : k.error ? (
        <Alert tone="danger" title="Não foi possível carregar o Kanban.">
          {k.error instanceof ApiError ? k.error.message : 'Tente atualizar.'}
        </Alert>
      ) : k.data && k.data.total === 0 ? (
        <EmptyState
          icon={<Columns3 />}
          title={debounced || group ? 'Nenhum cliente encontrado' : 'Nenhum cliente ativo'}
          description={debounced || group ? 'Revise a busca ou o grupo.' : 'Cadastre clientes para acompanhar as declarações aqui.'}
        />
      ) : (
        <div className="vf-kanban" style={{ opacity: k.isFetching ? 0.7 : 1, transition: 'opacity 200ms' } as CSSProperties}>
          {columns.map((col) => (
            <section
              key={col.stage}
              className={`vf-kanban__col${over === col.stage && dragging && dragging.stage !== col.stage ? ' vf-kanban__col--over' : ''}`}
              aria-label={`${col.label}: ${col.total} cliente(s)`}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (over !== col.stage) setOver(col.stage);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null);
              }}
              onDrop={(e) => onDrop(e, col.stage)}
            >
              <header className="vf-kanban__head">
                <span className="vf-kanban__title">
                  <span className="vf-kanban__dot" style={{ background: STAGE_COLOR[col.stage] }} aria-hidden />
                  <span>{col.label}</span>
                </span>
                <span className="vf-kanban__count">{col.total.toLocaleString('pt-BR')}</span>
              </header>
              {col.cards.length === 0 && <div className="vf-kanban__empty">Nenhum cliente nesta etapa</div>}
              {col.cards.map((card) => (
                <article
                  key={card.customerId}
                  className={`vf-kanban__card${dragging?.customerId === card.customerId ? ' vf-kanban__card--dragging' : ''}`}
                  draggable={canEdit}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', card.customerId);
                    setDragging(card);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  style={canEdit ? undefined : { cursor: 'default' }}
                >
                  <div className="vf-kanban__card-top">
                    <Link to={`/clientes/${card.customerId}`} className="vf-kanban__name" draggable={false}>
                      {card.name}
                    </Link>
                    {canEdit && (
                      <IconButton label={`Alterar status de ${card.name}`} onClick={() => setMove({ card, stage: null })}>
                        <ArrowRightLeft />
                      </IconButton>
                    )}
                  </div>
                  <span className="vf-kanban__meta vf-mono">{formatCpfCnpj(card.cpfCnpj)}</span>
                  <div className="vf-inline" style={{ '--gap': '4px' } as CSSProperties}>
                    <Tag tone={stageTone(card.stage)}>{substatusLabel(card.substatus)}</Tag>
                    {card.openBacklogs > 0 && (
                      <Tag tone="warning" icon={<FileWarning size={12} />}>
                        {card.openBacklogs} pendência(s)
                      </Tag>
                    )}
                    {card.groups.slice(0, 2).map((g) => (
                      <Tag key={g.id}>{g.name}</Tag>
                    ))}
                    {card.groups.length > 2 && <Tag>+{card.groups.length - 2}</Tag>}
                  </div>
                  {(card.taxDueCents > 0 || card.refundCents > 0 || card.responsibleName) && (
                    <div className="vf-inline vf-between vf-kanban__meta">
                      <span>{card.responsibleName ?? ''}</span>
                      {card.taxDueCents > 0 ? (
                        <span className="vf-danger-text">A pagar {formatMoney(card.taxDueCents)}</span>
                      ) : card.refundCents > 0 ? (
                        <span className="vf-success-text">Restituir {formatMoney(card.refundCents)}</span>
                      ) : null}
                    </div>
                  )}
                </article>
              ))}
              {col.cards.length < col.total && (
                <Button kind="tertiary" size="sm" loading={loadingMore === col.stage} onClick={() => void loadMore(col)}>
                  Carregar mais ({(col.total - col.cards.length).toLocaleString('pt-BR')} restantes)
                </Button>
              )}
            </section>
          ))}
        </div>
      )}

      <MoveDialog request={move} loading={moving} canFinish={can('declaration.finish')} onClose={() => setMove(null)} onConfirm={(card, s) => void applyMove(card, s)} />
      <ConfirmDialog
        open={Boolean(confirmFinish)}
        title="Finalizar declaração"
        message={confirmFinish ? `Marcar a declaração ${year} de ${confirmFinish.name} como finalizada?` : ''}
        confirmLabel="Finalizar"
        loading={moving}
        onConfirm={() => confirmFinish && void applyMove(confirmFinish, 'finished')}
        onClose={() => setConfirmFinish(null)}
      />
    </>
  );
}

/** Seletor do subestado de destino (ao soltar numa etapa com vários, ou pelo botão do cartão). */
function MoveDialog({
  request,
  loading,
  canFinish,
  onClose,
  onConfirm,
}: {
  request: MoveRequest | null;
  loading: boolean;
  canFinish: boolean;
  onClose: () => void;
  onConfirm: (card: KanbanCard, substatus: DeclarationSubstatus) => void;
}) {
  const [value, setValue] = useState<string>('');
  useEffect(() => {
    if (!request) return;
    setValue(request.stage ? STAGE_SUBSTATUS[request.stage][0] : request.card.substatus);
  }, [request]);
  if (!request) return null;
  const { card, stage } = request;
  const options = (stage ? STAGE_SUBSTATUS[stage] : (Object.keys(DECLARATION_SUBSTATUS) as DeclarationSubstatus[]))
    .filter((s) => canFinish || s !== 'finished')
    .map((s) => ({ value: s, label: stage ? DECLARATION_SUBSTATUS[s] : `${stageLabel(stageOfSubstatus(s))} · ${DECLARATION_SUBSTATUS[s]}` }));
  const unchanged = value === card.substatus;
  return (
    <Modal
      open
      title={stage ? `Mover para ${DECLARATION_STAGES[stage]}` : 'Alterar status da declaração'}
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={loading} disabled={!value || unchanged} onClick={() => onConfirm(card, value as DeclarationSubstatus)}>
            Confirmar
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <p className="vf-muted">
          <strong style={{ color: 'var(--color-text-high)' }}>{card.name}</strong> está em “{substatusLabel(card.substatus)}”.
        </p>
        {stage ? (
          <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="vf-stack">
            <legend className="vf-field__label" style={{ marginBottom: 8 }}>
              Status de destino
            </legend>
            {options.map((o) => (
              <label key={o.value} className="vf-check">
                <input type="radio" name="substatus" value={o.value} checked={value === o.value} onChange={() => setValue(o.value)} />
                <span>{o.label}</span>
              </label>
            ))}
          </fieldset>
        ) : (
          <Select label="Novo status" value={value} onChange={(e) => setValue(e.target.value)} options={options} />
        )}
      </div>
    </Modal>
  );
}
