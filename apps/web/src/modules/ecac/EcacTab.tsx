import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { KeyRound, Plus, RefreshCw, Save, ShieldCheck, Trash2 } from 'lucide-react';
import {
  AUTH_TYPES,
  CND_STATUS,
  DARF_SEND_STATUS,
  DARF_STATUS,
  ECAC_DECLARATION_STATUS,
  GOVBR_LEVELS,
  SITFIS_STATUS,
  TAXATION_TYPES,
  optionsOf,
  todayIso,
} from '@verifco/shared';
import { Alert, Button, Card, Checkbox, ConfirmDialog, DropFile, EmptyState, IconButton, Input, Loading, Modal, Select, Tabs, Tag, Textarea } from '../../ds';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { cndLabel, formatCpfCnpj, formatDate, formatDateTime, formatMoney, procurationLabel, procurationTone } from '../../lib/format';
import { useYear } from '../../lib/year';
import { useCustomer } from '../customers/customerContext';
import type { EcacPanel } from './types';
import { JobAlert, ViewFileButton, ecacStatusLabel, ecacTone, isRunning, pick, sourceLabel, taxationLabel } from './ui';

type Panel = 'declarations' | 'income' | 'darf' | 'cnd' | 'simplified' | 'mailbox';

export function EcacTab() {
  const { customer } = useCustomer();
  const { can } = useAuth();
  const key = ['ecac', customer.id];
  const q = useApi<EcacPanel>(key, `/customers/${customer.id}/ecac`);
  const { refetch } = q;
  const running = isRunning(q.data?.lastSync);
  // acompanha a sincronização enquanto estiver na fila
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void refetch(), 2000);
    return () => clearInterval(t);
  }, [running, refetch]);
  const [panel, setPanel] = useState<Panel>('declarations');
  const [showRecord, setShowRecord] = useState(false);
  const sync = useAction(() => api.post<{ alreadyQueued: boolean }>(`/customers/${customer.id}/ecac/sync`), {
    success: (r) => (r.alreadyQueued ? 'Já existe uma sincronização na fila para este cliente.' : 'Sincronização solicitada.'),
    invalidate: [key],
  });

  if (q.isLoading) return <Loading />;
  if (!q.data) return <Alert tone="danger">Não foi possível carregar os dados do eCAC.</Alert>;
  const d = q.data;

  return (
    <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>
      <div className="vf-grid" style={{ '--cols': 2 } as React.CSSProperties}>
        <CredentialsCard panel={d} onSaved={() => void q.refetch()} />
        <Card
          title="Procuração eletrônica"
          actions={
            can('ecac.sync') && (
              <Button kind="secondary" size="sm" icon={<RefreshCw />} loading={sync.isPending || running} onClick={() => sync.mutate(undefined)}>
                Solicitar sincronização
              </Button>
            )
          }
        >
          <dl className="vf-ecac-facts">
            <dt>Situação</dt>
            <dd>
              <Tag tone={procurationTone(d.procuration.status)}>{procurationLabel(d.procuration.status)}</Tag>
            </dd>
            <dt>Validade</dt>
            <dd>
              {d.procuration.expiresAt ? formatDate(d.procuration.expiresAt) : <span className="vf-muted">Não informada</span>}
              {d.procuration.expiringSoon && <Tag tone="warning">Vence em até 30 dias</Tag>}
              {d.procuration.expired && <Tag tone="danger">Expirada</Tag>}
            </dd>
            <dt>Procurador</dt>
            <dd>
              {d.procuration.procurator ? (
                <span>
                  {d.procuration.procurator.name} <span className="vf-muted vf-mono">· {formatCpfCnpj(d.procuration.procurator.cpfCnpj)}</span>
                  <span className="vf-muted"> · {pick(AUTH_TYPES, d.procuration.procurator.authType)}</span>
                </span>
              ) : (
                <span className="vf-muted">
                  Sem procurador associado. <Link to={`/clientes/${customer.id}/identificacao`}>Associar na identificação</Link>
                </span>
              )}
            </dd>
            <dt>Nível gov.br</dt>
            <dd>{d.procuration.govbrLevel ? <Tag tone={d.procuration.govbrLevel === 'bronze' ? 'warning' : 'neutral'}>{pick(GOVBR_LEVELS, d.procuration.govbrLevel)}</Tag> : <span className="vf-muted">Não informado</span>}</dd>
            <dt>Caixa postal</dt>
            <dd>
              {d.procuration.mailboxMessages > 0 ? (
                <Tag tone="warning">{d.procuration.mailboxMessages} mensagem(ns) não lida(s)</Tag>
              ) : (
                <span className="vf-muted">Nenhuma mensagem não lida registrada</span>
              )}
            </dd>
          </dl>
          {d.lastSync && (
            <div style={{ marginTop: 16 }}>
              <JobAlert job={d.lastSync} title="Última sincronização" done={((d.lastSync.result?.steps as string[] | undefined) ?? []).join(' · ')} />
            </div>
          )}
        </Card>
      </div>

      <Card
        flush
        title="Painéis do eCAC"
        actions={
          can('ecac.sync') && (
            <Button kind="secondary" size="sm" icon={<Plus />} onClick={() => setShowRecord(true)}>
              Lançar registro
            </Button>
          )
        }
      >
        <div style={{ padding: '0 24px' }}>
          <Tabs<Panel>
            value={panel}
            onChange={setPanel}
            items={[
              { value: 'declarations', label: `Declarações processadas (${d.declarations.length})` },
              { value: 'income', label: `Extrato de rendimentos (${d.incomeStatements.length})` },
              { value: 'darf', label: `DARF (${d.darfs.length})` },
              { value: 'cnd', label: 'CND' },
              { value: 'simplified', label: 'Situação fiscal' },
              { value: 'mailbox', label: `Caixa postal (${d.mailbox.length})` },
            ]}
          />
        </div>
        {panel === 'declarations' && <DeclarationsPanel d={d} />}
        {panel === 'income' && <IncomePanel d={d} />}
        {panel === 'darf' && <DarfPanel d={d} />}
        {panel === 'cnd' && <CndPanel d={d} />}
        {panel === 'simplified' && <SimplifiedPanel d={d} />}
        {panel === 'mailbox' && <MailboxPanel d={d} />}
      </Card>
      <RecordModal open={showRecord} onClose={() => setShowRecord(false)} customerId={customer.id} onSaved={() => void q.refetch()} />
    </div>
  );
}

// ---------------------------------------------------------------- credenciais
function CredentialsCard({ panel, onSaved }: { panel: EcacPanel; onSaved: () => void }) {
  const { customer, refetch } = useCustomer();
  const { can } = useAuth();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const configured = panel.credentials.hasLogin && panel.credentials.hasPassword;
  const done = () => {
    setLogin('');
    setPassword('');
    setConfirmRemove(false);
    onSaved();
    refetch();
  };
  const save = useAction(
    () =>
      api.put(`/customers/${customer.id}/credentials`, {
        ...(login ? { ecacLogin: login } : {}),
        ...(password ? { ecacPassword: password } : {}),
      }),
    { success: 'Credenciais salvas.', onSuccess: done },
  );
  const remove = useAction(() => api.put(`/customers/${customer.id}/credentials`, { ecacLogin: null, ecacPassword: null }), { success: 'Credenciais removidas.', onSuccess: done });
  const editable = can('ecac.credentials');
  return (
    <Card title="Acesso eCAC / gov.br" actions={<Tag tone={configured ? 'success' : 'neutral'} icon={configured ? <ShieldCheck size={14} /> : <KeyRound size={14} />}>{configured ? 'Configurado' : 'Sem login'}</Tag>}>
      <div className="vf-stack">
        <div className="vf-grid" style={{ '--cols': 2 } as React.CSSProperties}>
          <Input
            label="Login eCAC"
            type="password"
            autoComplete="off"
            placeholder={panel.credentials.hasLogin ? '•••••••• (configurado)' : 'CPF do cliente'}
            value={login}
            disabled={!editable}
            onChange={(e) => setLogin(e.target.value)}
          />
          <Input
            label="Senha eCAC"
            type="password"
            autoComplete="new-password"
            placeholder={panel.credentials.hasPassword ? '•••••••• (configurada)' : 'Senha gov.br'}
            value={password}
            disabled={!editable}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <span className="vf-text-xs vf-muted">
          Guardadas cifradas e nunca exibidas de volta. Para trocar, digite os novos valores; campos vazios mantêm o que já está salvo.
        </span>
        {editable && (
          <div className="vf-inline vf-end">
            {configured && (
              <Button kind="tertiary" icon={<Trash2 />} onClick={() => setConfirmRemove(true)}>
                Remover
              </Button>
            )}
            <Button icon={<Save />} disabled={!login && !password} loading={save.isPending} onClick={() => save.mutate(undefined)}>
              Salvar
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmRemove}
        title="Remover credenciais"
        message="O login e a senha eCAC deste cliente serão apagados."
        confirmLabel="Remover"
        danger
        loading={remove.isPending}
        onConfirm={() => remove.mutate(undefined)}
        onClose={() => setConfirmRemove(false)}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- painéis
/** O SERPRO não informa a situação da declaração nem extratos: esses painéis vêm de lançamento manual. */
const MANUAL_HINT = 'O SERPRO Integra Contador não informa este dado e a extensão ainda não lê esta página do eCAC: lance aqui o que consultar no eCAC (Lançar registro).';

function DeclarationsPanel({ d }: { d: EcacPanel }) {
  if (!d.declarations.length) return <EmptyState title="Nenhuma declaração processada registrada" description={`Situação, malha e lote de restituição. ${MANUAL_HINT}`} />;
  return (
    <div className="vf-table-wrap">
      <table className="vf-table">
        <thead>
          <tr>
            <th>Ano</th>
            <th>Status</th>
            <th>Tipo</th>
            <th>Original/retificadora</th>
            <th>Tributação</th>
            <th>Origem</th>
            <th className="actions">Opções</th>
          </tr>
        </thead>
        <tbody>
          {d.declarations.map((r) => (
            <tr key={r.id}>
              <td className="vf-mono">{r.year ?? '—'}</td>
              <td>
                <Tag tone={ecacTone(r.status)}>{ecacStatusLabel(r.status)}</Tag>
              </td>
              <td>{r.type ?? '—'}</td>
              <td>{r.isRectification === null ? '—' : r.isRectification ? 'Retificadora' : 'Original'}</td>
              <td>{taxationLabel(r.taxation)}</td>
              <td className="vf-muted">{sourceLabel(r.source)}</td>
              <td className="actions">
                <RecordActions customerId={d.customer.id} recordId={r.id} fileId={r.fileId} manual={r.source === 'manual'} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IncomePanel({ d }: { d: EcacPanel }) {
  if (!d.incomeStatements.length) return <EmptyState title="Nenhum extrato de rendimentos" description={MANUAL_HINT} />;
  return (
    <div className="vf-table-wrap">
      <table className="vf-table">
        <thead>
          <tr>
            <th>Ano</th>
            <th>Data de emissão</th>
            <th>Descrição</th>
            <th>Origem</th>
            <th className="actions">Visualizar</th>
          </tr>
        </thead>
        <tbody>
          {d.incomeStatements.map((r) => (
            <tr key={r.id}>
              <td className="vf-mono">{r.year ?? '—'}</td>
              <td>{r.issuedAt ? formatDate(r.issuedAt) : '—'}</td>
              <td>{r.description ?? '—'}</td>
              <td className="vf-muted">{sourceLabel(r.source)}</td>
              <td className="actions">
                <RecordActions customerId={d.customer.id} recordId={r.id} fileId={r.fileId} manual={r.source === 'manual'} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DarfPanel({ d }: { d: EcacPanel }) {
  if (!d.darfs.length) {
    return (
      <EmptyState
        title="Nenhum DARF acompanhado"
        description="As guias aparecem aqui quando são lançadas na etapa DARF do IRPF. Com o SERPRO ativo, o robô marca como pagas as quotas que encontrar no PAGTOWEB."
      />
    );
  }
  return (
    <div className="vf-table-wrap">
      <table className="vf-table">
        <thead>
          <tr>
            <th>Exercício</th>
            <th>Quota</th>
            <th className="num">Valor</th>
            <th>Data de vencimento</th>
            <th>Status da parcela</th>
            <th>Status do envio</th>
            <th className="actions">PDF</th>
          </tr>
        </thead>
        <tbody>
          {d.darfs.map((r) => (
            <tr key={r.id}>
              <td className="vf-mono">{r.year ?? '—'}</td>
              <td>{r.quotaNumber}ª</td>
              <td className="num">{formatMoney(r.valueCents)}</td>
              <td>{formatDate(r.dueDate)}</td>
              <td>
                <Tag tone={r.status === 'paid' ? 'success' : r.status === 'overdue' ? 'danger' : 'warning'}>{pick(DARF_STATUS, r.status)}</Tag>
              </td>
              <td>
                <Tag tone={r.sendStatus === 'sent' ? 'success' : r.sendStatus === 'failed' ? 'danger' : 'neutral'}>{pick(DARF_SEND_STATUS, r.sendStatus)}</Tag>
              </td>
              <td className="actions">
                <ViewFileButton fileId={r.fileId} label="Abrir PDF" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CndPanel({ d }: { d: EcacPanel }) {
  return (
    <div className="vf-stack" style={{ padding: 24 }}>
      <Alert title="A CND é lançada pelo escritório">
        O robô não emite a certidão de pessoa física: o SERPRO Integra Contador não oferece esse serviço. Emita a CND no site da Receita e lance-a aqui (Lançar
        registro › Certidão). O relatório de situação fiscal, na aba ao lado, mostra as pendências que impedem a certidão.
      </Alert>
      <dl className="vf-ecac-facts">
        <dt>Situação</dt>
        <dd>
          <Tag tone={d.cnd.status === 'success' ? 'success' : d.cnd.status === 'not_requested' ? 'neutral' : 'warning'}>{cndLabel(d.cnd.status)}</Tag>
        </dd>
        <dt>Última consulta</dt>
        <dd>{d.cnd.checkedAt ? formatDateTime(d.cnd.checkedAt) : <span className="vf-muted">Nunca consultada</span>}</dd>
        <dt>Certidão</dt>
        <dd>
          {d.cnd.latest?.fileId ? (
            <span className="vf-inline">
              <ViewFileButton fileId={d.cnd.latest.fileId} label="Abrir certidão" />
              {d.cnd.latest.issuedAt && <span>Emitida em {formatDate(d.cnd.latest.issuedAt)}</span>}
              {d.cnd.latest.validUntil && <span className="vf-muted">· válida até {formatDate(d.cnd.latest.validUntil)}</span>}
            </span>
          ) : (
            <span className="vf-muted">Nenhum arquivo de certidão registrado</span>
          )}
        </dd>
      </dl>
    </div>
  );
}

const SITFIS_TONE = { regular: 'success', pending: 'warning', unknown: 'neutral' } as const;

function SimplifiedPanel({ d }: { d: EcacPanel }) {
  const s = d.simplified;
  if (!s) {
    return (
      <div style={{ padding: 24 }}>
        <Alert title="O relatório de situação fiscal vem do SERPRO Integra Contador">
          <ol className="vf-ecac-steps">
            <li>Associe um procurador ao cliente (aba Identificação).</li>
            <li>Confirme a procuração eletrônica no eCAC, em nome do cliente.</li>
            <li>Configure e ative o SERPRO em Administração › Integrações.</li>
            <li>A sincronização automática (quando ligada em Administração › Integrações) emite o relatório a cada 30 dias; “Solicitar sincronização” acima emite na hora. O PDF e a leitura dele aparecem nesta aba.</li>
          </ol>
        </Alert>
      </div>
    );
  }
  const cert = s.certificate;
  const certValid = Boolean(cert?.validUntil && cert.validUntil >= todayIso());
  return (
    <div className="vf-stack" style={{ padding: 24 }}>
      <dl className="vf-ecac-facts">
        <dt>Documento</dt>
        <dd>
          <span className="vf-inline">
            {s.kind === 'fiscal_situation' ? 'Relatório de situação fiscal' : 'Status simplificado'}
            {s.fileId && <ViewFileButton fileId={s.fileId} label="Abrir relatório" />}
          </span>
        </dd>
        <dt>Situação</dt>
        <dd>
          {s.status ? (
            <Tag tone={SITFIS_TONE[s.status]}>{SITFIS_STATUS[s.status]}</Tag>
          ) : (
            (s.situation ?? (s.fileId ? 'Veja as pendências no PDF' : '—'))
          )}
        </dd>
        <dt>Atualizado em</dt>
        <dd>
          {formatDateTime(s.fetchedAt)} <span className="vf-muted">· {sourceLabel(s.source)}</span>
        </dd>
        {s.message && (
          <>
            <dt>Mensagem</dt>
            <dd>{s.message}</dd>
          </>
        )}
        {cert && (
          <>
            <dt>Certidão no relatório</dt>
            <dd>
              <span>Certidão {cert.type}</span>
              {cert.code && <span className="vf-muted vf-mono">· {cert.code}</span>}
              {cert.issuedAt && <span className="vf-muted">· emitida em {formatDate(cert.issuedAt)}</span>}
              {cert.validUntil && <span className="vf-muted">· válida até {formatDate(cert.validUntil)}</span>}
              {cert.validUntil && !certValid && <Tag tone="danger">Vencida</Tag>}
              {!cert.validUntil && <span className="vf-muted">· datas não informadas no relatório</span>}
            </dd>
          </>
        )}
      </dl>
      {s.pendencies.length > 0 && (
        <Alert tone="warning" title="Pendências">
          <ul className="vf-ecac-steps">
            {s.pendencies.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </Alert>
      )}
      {s.kind === 'fiscal_situation' && s.fileId && (
        <span className="vf-text-xs vf-muted">A leitura acima é automática e serve de resumo; o PDF do relatório, emitido pela Receita Federal, é o documento que vale.</span>
      )}
    </div>
  );
}

function MailboxPanel({ d }: { d: EcacPanel }) {
  if (!d.mailbox.length) {
    return <EmptyState title="Nenhuma mensagem registrada" description="As mensagens chegam pela sincronização do SERPRO Integra Contador (clientes com procuração) ou por lançamento manual." />;
  }
  return (
    <div className="vf-table-wrap">
      <table className="vf-table">
        <thead>
          <tr>
            <th>Assunto</th>
            <th>Recebida em</th>
            <th>Leitura</th>
            <th>Origem</th>
            <th className="actions">Opções</th>
          </tr>
        </thead>
        <tbody>
          {d.mailbox.map((r) => (
            <tr key={r.id}>
              <td>{r.subject ?? '—'}</td>
              <td>{r.receivedAt ? formatDate(r.receivedAt) : '—'}</td>
              <td>{r.read ? <Tag>Lida</Tag> : <Tag tone="warning">Não lida</Tag>}</td>
              <td className="vf-muted">{sourceLabel(r.source)}</td>
              <td className="actions">
                <RecordActions customerId={d.customer.id} recordId={r.id} fileId={r.fileId} manual={r.source === 'manual'} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecordActions({ customerId, recordId, fileId, manual }: { customerId: string; recordId: string; fileId: string | null; manual: boolean }) {
  const { can } = useAuth();
  const [confirm, setConfirm] = useState(false);
  const del = useAction(() => api.del(`/customers/${customerId}/ecac/records/${recordId}`), { success: 'Registro removido.', invalidate: [['ecac', customerId]] });
  return (
    <span className="vf-inline" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
      {fileId ? <ViewFileButton fileId={fileId} /> : null}
      {manual && can('ecac.sync') && (
        <IconButton label="Remover registro manual" onClick={() => setConfirm(true)}>
          <Trash2 />
        </IconButton>
      )}
      <ConfirmDialog
        open={confirm}
        title="Remover registro"
        message="O registro lançado manualmente e o arquivo anexado serão removidos."
        confirmLabel="Remover"
        danger
        loading={del.isPending}
        onConfirm={() => del.mutate(undefined)}
        onClose={() => setConfirm(false)}
      />
    </span>
  );
}

// ---------------------------------------------------------------- lançamento manual
const KIND_OPTIONS = [
  { value: 'declaration', label: 'Declaração processada' },
  { value: 'income_statement', label: 'Extrato de rendimentos' },
  { value: 'cnd', label: 'Certidão (CND)' },
  { value: 'simplified_status', label: 'Status simplificado' },
  { value: 'mailbox_message', label: 'Mensagem da caixa postal' },
  { value: 'other', label: 'Outro' },
];

function RecordModal({ open, onClose, customerId, onSaved }: { open: boolean; onClose: () => void; customerId: string; onSaved: () => void }) {
  const { year } = useYear();
  const [kind, setKind] = useState('declaration');
  const [y, setY] = useState(String(year));
  const [f, setF] = useState<Record<string, string>>({});
  const [flag, setFlag] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  useEffect(() => {
    if (open) {
      setF({});
      setFlag(false);
      setFile(null);
      setY(String(year));
    }
  }, [open, year]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const data = (): Record<string, unknown> => {
    switch (kind) {
      case 'declaration':
        return { status: f.status || undefined, type: f.type || undefined, isRectification: flag, taxation: f.taxation || undefined, receiptNumber: f.receiptNumber || undefined };
      case 'income_statement':
        return { issuedAt: f.issuedAt || undefined, description: f.description || undefined };
      case 'cnd':
        return { status: f.status || undefined, issuedAt: f.issuedAt || undefined, validUntil: f.validUntil || undefined };
      case 'simplified_status':
        return { situation: f.situation || undefined, message: f.message || undefined, pendencies: (f.pendencies ?? '').split('\n').map((s) => s.trim()).filter(Boolean) };
      case 'mailbox_message':
        return { subject: f.subject || undefined, receivedAt: f.receivedAt || undefined, read: flag };
      default:
        return { description: f.description || undefined };
    }
  };
  const save = useAction(() => api.upload(`/customers/${customerId}/ecac/records`, file ? [file] : [], { kind, year: y, data: JSON.stringify(data()) }), {
    success: 'Registro lançado.',
    invalidate: [['ecac', customerId]],
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Modal
      open={open}
      title="Lançar registro do eCAC"
      onClose={onClose}
      width={620}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Lançar
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <span className="vf-muted">Use para registrar o que foi consultado manualmente no eCAC (por exemplo, um extrato baixado). O registro fica marcado como “Lançamento manual”.</span>
        <div className="vf-grid" style={{ '--cols': 2 } as React.CSSProperties}>
          <Select label="Tipo de registro" value={kind} onChange={(e) => setKind(e.target.value)} options={KIND_OPTIONS} />
          <Input label="Ano-exercício" type="number" value={y} onChange={(e) => setY(e.target.value)} />
          {kind === 'declaration' && (
            <>
              <Select label="Status no eCAC" placeholder="Selecione" value={f.status ?? ''} onChange={set('status')} options={optionsOf(ECAC_DECLARATION_STATUS)} />
              <Input label="Tipo" placeholder="Ex.: Ajuste anual" value={f.type ?? ''} onChange={set('type')} />
              <Select label="Tributação" placeholder="Não informada" value={f.taxation ?? ''} onChange={set('taxation')} options={optionsOf(TAXATION_TYPES)} />
              <Input label="Número do recibo" value={f.receiptNumber ?? ''} onChange={set('receiptNumber')} />
              <Checkbox label="Retificadora" checked={flag} onChange={(e) => setFlag(e.target.checked)} />
            </>
          )}
          {kind === 'income_statement' && (
            <>
              <Input label="Data de emissão" type="date" value={f.issuedAt ?? ''} onChange={set('issuedAt')} />
              <Input label="Descrição" value={f.description ?? ''} onChange={set('description')} />
            </>
          )}
          {kind === 'cnd' && (
            <>
              <Select label="Situação" placeholder="Selecione" value={f.status ?? ''} onChange={set('status')} options={optionsOf(CND_STATUS)} />
              <Input label="Emitida em" type="date" value={f.issuedAt ?? ''} onChange={set('issuedAt')} />
              <Input label="Válida até" type="date" value={f.validUntil ?? ''} onChange={set('validUntil')} />
            </>
          )}
          {kind === 'simplified_status' && (
            <>
              <Input label="Situação" value={f.situation ?? ''} onChange={set('situation')} />
              <Input label="Mensagem" value={f.message ?? ''} onChange={set('message')} />
              <div className="vf-span-2">
                <Textarea label="Pendências (uma por linha)" value={f.pendencies ?? ''} onChange={set('pendencies')} />
              </div>
            </>
          )}
          {kind === 'mailbox_message' && (
            <>
              <Input label="Assunto" value={f.subject ?? ''} onChange={set('subject')} />
              <Input label="Recebida em" type="date" value={f.receivedAt ?? ''} onChange={set('receivedAt')} />
              <Checkbox label="Já lida" checked={flag} onChange={(e) => setFlag(e.target.checked)} />
            </>
          )}
          {kind === 'other' && <Input label="Descrição" value={f.description ?? ''} onChange={set('description')} span={2} />}
        </div>
        {file ? (
          <div className="vf-inline">
            <Tag tone="primary">{file.name}</Tag>
            <Button kind="tertiary" size="sm" onClick={() => setFile(null)}>
              Trocar arquivo
            </Button>
          </div>
        ) : (
          <DropFile onFiles={(fs) => setFile(fs[0] ?? null)} accept=".pdf,.png,.jpg,.jpeg,.xml" title="Anexe o arquivo (opcional)" hint="PDF, imagem ou XML, até 25 MB" />
        )}
      </div>
    </Modal>
  );
}
