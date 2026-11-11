import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Ban, Copy, Download, FolderInput, Inbox, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { ECAC_RECORD_KINDS, MACHINE_TOKEN_SCOPES, currentExerciseYear, formatCpfCnpj, optionsOf } from '@verifco/shared';
import { Alert, Button, Card, ConfirmDialog, EmptyState, IconButton, Input, Loading, Modal, Select, Stat, Tag, useToast } from '../../ds';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi, useDebounced } from '../../lib/hooks';
import { formatDateTime } from '../../lib/format';
import type { InboxItem, MachineToken, RobotOverview } from './types';
import { JobAlert, apiBaseUrl, isRunning, pick, sourceLabel } from './ui';

export function RobotAdminTab() {
  const { can } = useAuth();
  const overview = useApi<RobotOverview>(['robot', 'overview'], '/robot/overview');
  const { refetch } = overview;
  const running = isRunning(overview.data?.lastOfficeSync);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void refetch(), 2000);
    return () => clearInterval(t);
  }, [running, refetch]);
  const syncAll = useAction(() => api.post<{ alreadyQueued: boolean }>('/robot/sync-office'), {
    success: (r) => (r.alreadyQueued ? 'Já existe uma sincronização geral na fila.' : 'Sincronização geral solicitada.'),
    invalidate: [['robot']],
  });
  const o = overview.data;

  return (
    <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>
      <Card>
        {!o ? (
          <Loading />
        ) : (
          <div className="vf-grid" style={{ '--cols': 4 } as React.CSSProperties}>
            <Stat label="Clientes com procurador" value={o.customersWithProcurator} hint="Base percorrida pelo robô" />
            <Stat
              label="Tokens ativos"
              value={o.activeTokens}
              hint={o.inboxPending > 0 ? <span className="vf-danger-text">{o.inboxPending} arquivo(s) sem cliente, abaixo</span> : 'Extensões e sincronizadores'}
            />
            <Stat
              label="SERPRO Integra Contador"
              value={o.serpro === 'ready' ? 'Ativo' : o.serpro === 'not_configured' ? 'Não configurado' : 'Indisponível'}
              hint={o.serpro === 'missing' ? 'Integração ausente nesta instalação' : <Link to="/admin/integracoes">Meu escritório › Integrações</Link>}
            />
            <Stat label="Última sincronização geral" value={o.lastOfficeSync ? formatDateTime(o.lastOfficeSync.createdAt) : '—'} hint={o.lastOfficeSync ? pick({ queued: 'Na fila', running: 'Executando', done: 'Concluída', failed: 'Falhou' }, o.lastOfficeSync.status) : 'Nunca executada'} />
          </div>
        )}
      </Card>

      <Card
        title="Sincronização eCAC"
        actions={
          can('ecac.sync') && (
            <Button kind="secondary" icon={<RefreshCw />} loading={syncAll.isPending || running} onClick={() => syncAll.mutate(undefined)}>
              Sincronizar clientes com procurador
            </Button>
          )
        }
      >
        <div className="vf-stack">
          <span className="vf-muted">
            O robô reúne os dados do eCAC por três caminhos: a integração oficial <strong>SERPRO Integra Contador</strong> (procuração, caixa postal, situação fiscal e pagamentos do DARF, sem depender do seu computador), a{' '}
            <strong>extensão do navegador</strong> (abre os serviços do eCAC e manda para a pasta do cliente o arquivo baixado, a página registrada ou a situação que você conferiu na tela; ela não lê as páginas do eCAC sozinha) e o{' '}
            <strong>sincronizador</strong> (guarda nos documentos do cliente os arquivos .DEC, .REC e .DBK do programa IRPF; o recibo .REC marca a declaração como transmitida). Nada é simulado: sem uma dessas fontes, os painéis ficam vazios.
          </span>
          <ul className="vf-ecac-steps vf-text-xs">
            <li>
              Pelo SERPRO, quando você pede e na sincronização automática (desligada, diária ou semanal, em Meu escritório › Integrações): procuração eletrônica, mensagens da caixa postal, relatório de situação fiscal (a cada 30 dias, com a leitura das pendências e da certidão vigente) e
              pagamento das quotas do DARF perto do vencimento (receita 0211). Cada cliente é sincronizado numa tarefa própria.
            </li>
            <li>O SERPRO não informa a situação da declaração (processamento, malha, lote de restituição) nem emite a CND de pessoa física: lance esses dados na aba eCAC do cliente.</li>
            {o?.nextAutoSync ? (
              <li>Próxima sincronização automática: {formatDateTime(o.nextAutoSync)}.</li>
            ) : (
              o?.serpro === 'ready' && <li>Sincronização automática desligada: os clientes são consultados só quando você pede. Cada consulta é cobrada pelo SERPRO.</li>
            )}
          </ul>
          {o?.lastOfficeSync && <JobAlert job={o.lastOfficeSync} title="Sincronização geral" done={`${String(o.lastOfficeSync.result?.ok ?? 0)} de ${String(o.lastOfficeSync.result?.total ?? 0)} cliente(s) sincronizado(s).`} />}
        </div>
      </Card>

      {can('ecac.robot') && (o?.inboxPending ?? 0) > 0 && <InboxCard />}
      {can('ecac.robot') && <TokensCard latest={o?.clientVersions ?? null} />}

      <Card flush title="Atividade recente do robô">
        {!o ? (
          <Loading />
        ) : o.activity.length === 0 ? (
          <EmptyState title="Nenhuma atividade ainda" description="Arquivos do sincronizador, registros da extensão e pré-preenchidas recebidas aparecem aqui." />
        ) : (
          <div className="vf-table-wrap" style={{ marginTop: 16 }}>
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Cliente</th>
                  <th>Tipo</th>
                  <th>Detalhe</th>
                </tr>
              </thead>
              <tbody>
                {o.activity.map((a, i) => (
                  <tr key={i}>
                    <td className="vf-mono">{formatDateTime(a.at)}</td>
                    <td>
                      <Link to={`/clientes/${a.customerId}/ecac`}>{a.customerName}</Link>
                    </td>
                    <td>
                      {a.type === 'file' ? <Tag tone="primary">Arquivo do sincronizador</Tag> : a.type === 'prefilled' ? <Tag tone="highlight">Pré-preenchida {a.category}</Tag> : <Tag>{sourceLabel(a.category)}</Tag>}
                    </td>
                    <td>{a.type === 'record' ? pick(ECAC_RECORD_KINDS, a.detail) : a.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/** `a` é mais antiga que `b` (versões `x.y.z`). */
const olderThan = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  return false;
};

const PLATFORMS: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

const fileSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Arquivos que o sincronizador não conseguiu ligar a um cliente: atribuir ou descartar. */
function InboxCard() {
  const inbox = useApi<InboxItem[]>(['robot', 'inbox'], '/robot/inbox');
  const [filing, setFiling] = useState<InboxItem | null>(null);
  const [discarding, setDiscarding] = useState<InboxItem | null>(null);
  const toast = useToast();
  const discard = useAction((id: string) => api.del(`/robot/inbox/${id}`), { success: 'Arquivo descartado.', invalidate: [['robot']], onSuccess: () => setDiscarding(null) });
  const download = async (item: InboxItem) => {
    try {
      await api.download(`/robot/inbox/${item.id}/download`, item.filename);
    } catch {
      toast.error('Não foi possível baixar o arquivo.');
    }
  };

  return (
    <Card flush title="Arquivos sem cliente">
      <div style={{ padding: '0 24px 16px' }} className="vf-muted">
        O sincronizador encontrou estes arquivos e não soube de quem são: o nome não traz um CPF confiável ou o CPF ainda não está cadastrado. Atribua cada um a um cliente (ele entra na pasta do cliente como qualquer arquivo do
        sincronizador) ou descarte.
      </div>
      {inbox.isLoading ? (
        <Loading />
      ) : !inbox.data?.length ? (
        <EmptyState icon={<Inbox />} title="Nenhum arquivo pendente" />
      ) : (
        <div className="vf-table-wrap">
          <table className="vf-table">
            <thead>
              <tr>
                <th>Arquivo</th>
                <th>Motivo</th>
                <th>CPF no arquivo</th>
                <th>Exercício</th>
                <th>Recebido</th>
                <th className="actions">Opções</th>
              </tr>
            </thead>
            <tbody>
              {inbox.data.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className="vf-text-sm-bold" style={{ wordBreak: 'break-all' }}>
                      {item.filename}
                    </span>
                    <div className="vf-text-xs vf-muted" style={{ wordBreak: 'break-all' }}>
                      {fileSize(item.size)}
                      {item.originalPath ? ` · ${item.originalPath}` : ''}
                    </div>
                  </td>
                  <td>
                    <Tag tone={item.reason === 'sem_cpf' ? 'warning' : 'highlight'}>{item.reasonLabel}</Tag>
                  </td>
                  <td>
                    {item.cpf ? <span className="vf-mono">{formatCpfCnpj(item.cpf)}</span> : <span className="vf-muted">—</span>}
                    {item.suggestedCustomer && <div className="vf-text-xs vf-muted">Cadastrado: {item.suggestedCustomer.name}</div>}
                  </td>
                  <td>{item.exerciseYear ?? <span className="vf-muted">—</span>}</td>
                  <td>
                    {formatDateTime(item.createdAt)}
                    {item.tokenName && <div className="vf-text-xs vf-muted">{item.tokenName}</div>}
                  </td>
                  <td className="actions">
                    <span className="vf-inline" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      <IconButton label="Baixar arquivo" onClick={() => void download(item)}>
                        <Download />
                      </IconButton>
                      <Button kind="secondary" size="sm" icon={<FolderInput />} onClick={() => setFiling(item)}>
                        Atribuir
                      </Button>
                      <IconButton label="Descartar arquivo" onClick={() => setDiscarding(item)}>
                        <Trash2 />
                      </IconButton>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {filing && <FileInboxModal item={filing} onClose={() => setFiling(null)} />}
      <ConfirmDialog
        open={Boolean(discarding)}
        title="Descartar arquivo"
        message={`"${discarding?.filename ?? ''}" será apagado do Verifco. O arquivo continua no computador de origem, mas o sincronizador não o envia de novo.`}
        confirmLabel="Descartar"
        danger
        loading={discard.isPending}
        onConfirm={() => discarding && discard.mutate(discarding.id)}
        onClose={() => setDiscarding(null)}
      />
    </Card>
  );
}

interface CustomerHit {
  id: string;
  name: string;
  cpfCnpj: string;
}

function FileInboxModal({ item, onClose }: { item: InboxItem; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<{ id: string; name: string } | null>(item.suggestedCustomer);
  const [year, setYear] = useState(String(item.exerciseYear ?? currentExerciseYear()));
  const term = useDebounced(search.trim());
  const hits = useApi<{ data: CustomerHit[] }>(['customers', 'inbox-search', term], term.length >= 2 ? `/customers?search=${encodeURIComponent(term)}&pageSize=8` : null);
  const y = Number(year);
  const validYear = Number.isInteger(y) && y >= 2000 && y <= 2100;
  const file = useAction(() => api.post<{ duplicate: boolean; customer: { name: string } }>(`/robot/inbox/${item.id}/file`, { customerId: chosen!.id, year: y }), {
    success: (r) => (r.duplicate ? `${r.customer.name} já tinha este arquivo: nada foi duplicado.` : `Arquivo guardado na pasta de ${r.customer.name}.`),
    invalidate: [['robot'], ['ecac'], ['documents']],
    onSuccess: onClose,
  });

  return (
    <Modal
      open
      title="Atribuir arquivo a um cliente"
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={file.isPending} disabled={!chosen || !validYear} onClick={() => file.mutate(undefined)}>
            Atribuir
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <span className="vf-muted" style={{ wordBreak: 'break-all' }}>
          {item.filename}
        </span>
        {chosen ? (
          <div className="vf-inline">
            <Tag tone="primary">{chosen.name}</Tag>
            <Button kind="tertiary" size="sm" onClick={() => setChosen(null)}>
              Trocar cliente
            </Button>
          </div>
        ) : (
          <>
            <Input label="Cliente" placeholder="Nome ou CPF" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
            {term.length >= 2 &&
              (hits.isLoading ? (
                <Loading />
              ) : !hits.data?.data.length ? (
                <span className="vf-muted">Nenhum cliente encontrado. Cadastre o cliente e volte aqui.</span>
              ) : (
                <ul className="vf-ecac-picker">
                  {hits.data.data.map((c) => (
                    <li key={c.id}>
                      <button type="button" onClick={() => setChosen({ id: c.id, name: c.name })}>
                        <span className="vf-text-sm-bold">{c.name}</span>
                        <span className="vf-mono vf-muted">{formatCpfCnpj(c.cpfCnpj)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ))}
          </>
        )}
        <Input label="Ano-exercício" inputMode="numeric" maxLength={4} value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, ''))} error={year && !validYear ? 'Informe o ano com 4 dígitos.' : undefined} />
      </div>
    </Modal>
  );
}

function TokensCard({ latest }: { latest: RobotOverview['clientVersions'] | null }) {
  const toast = useToast();
  const tokens = useApi<MachineToken[]>(['robot', 'tokens'], '/robot/tokens');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'extension' | 'sync'>('sync');
  const [created, setCreated] = useState<(MachineToken & { token: string }) | null>(null);
  const [revoking, setRevoking] = useState<MachineToken | null>(null);
  const create = useAction(() => api.post<MachineToken & { token: string }>('/robot/tokens', { name, scope }), {
    invalidate: [['robot']],
    onSuccess: (r) => {
      setCreating(false);
      setName('');
      setCreated(r);
    },
  });
  const revoke = useAction((id: string) => api.del(`/robot/tokens/${id}`), { success: 'Token revogado.', invalidate: [['robot']], onSuccess: () => setRevoking(null) });
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Token copiado.');
    } catch {
      toast.error('Não foi possível copiar. Selecione o texto e copie manualmente.');
    }
  };

  return (
    <Card
      flush
      title="Tokens de máquina"
      actions={
        <Button icon={<Plus />} onClick={() => setCreating(true)}>
          Novo token
        </Button>
      }
    >
      <div style={{ padding: '0 24px 16px' }} className="vf-muted">
        Cada computador com o sincronizador e cada navegador com a extensão usa o seu token (<span className="vf-mono">vfk_…</span>). Guardamos só uma impressão digital do token: ele aparece uma única vez, na criação. Revogue o
        token de um computador desativado.
      </div>
      {tokens.isLoading ? (
        <Loading />
      ) : !tokens.data?.length ? (
        <EmptyState icon={<KeyRound />} title="Nenhum token criado" description="Crie um token para conectar a extensão do navegador ou o sincronizador." />
      ) : (
        <div className="vf-table-wrap">
          <table className="vf-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Escopo</th>
                <th>Token</th>
                <th>Criado por</th>
                <th>Último uso</th>
                <th>Versão</th>
                <th>Situação</th>
                <th className="actions" />
              </tr>
            </thead>
            <tbody>
              {tokens.data.map((t) => (
                <tr key={t.id}>
                  <td className="vf-text-sm-bold">{t.name}</td>
                  <td>{MACHINE_TOKEN_SCOPES[t.scope]}</td>
                  <td className="vf-mono">{t.prefix}…</td>
                  <td>
                    {t.createdByName ?? '—'}
                    <div className="vf-text-xs vf-muted">{formatDateTime(t.createdAt)}</div>
                  </td>
                  <td>{t.lastUsedAt ? formatDateTime(t.lastUsedAt) : <span className="vf-muted">Nunca usado</span>}</td>
                  <td>
                    {t.clientVersion ? (
                      <>
                        <span className="vf-mono">{t.clientVersion}</span>
                        {t.clientPlatform && <span className="vf-muted"> · {PLATFORMS[t.clientPlatform] ?? t.clientPlatform}</span>}
                        {t.active && latest?.[t.scope] && olderThan(t.clientVersion, latest[t.scope]!) && (
                          <div className="vf-text-xs">
                            <Link to="/downloads">Atualizar para {latest[t.scope]}</Link>
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="vf-muted">—</span>
                    )}
                  </td>
                  <td>{t.active ? <Tag tone="success">Ativo</Tag> : <Tag tone="danger">Revogado em {formatDateTime(t.revokedAt)}</Tag>}</td>
                  <td className="actions">
                    {t.active && (
                      <Button kind="tertiary" size="sm" icon={<Ban />} onClick={() => setRevoking(t)}>
                        Revogar
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={creating}
        title="Novo token de máquina"
        onClose={() => setCreating(false)}
        width={480}
        footer={
          <>
            <Button kind="secondary" onClick={() => setCreating(false)}>
              Cancelar
            </Button>
            <Button loading={create.isPending} disabled={name.trim().length < 2} onClick={() => create.mutate(undefined)}>
              Criar token
            </Button>
          </>
        }
      >
        <div className="vf-stack">
          <Input label="Nome" placeholder="Ex.: Computador da Ana" value={name} onChange={(e) => setName(e.target.value)} required />
          <Select label="Escopo" value={scope} onChange={(e) => setScope(e.target.value as 'extension' | 'sync')} options={optionsOf(MACHINE_TOKEN_SCOPES)} />
          <span className="vf-text-xs vf-muted">
            {scope === 'sync'
              ? 'Sincronizador: envia arquivos do programa IRPF e pré-preenchidas e consulta os clientes do escritório pelo nome ou CPF.'
              : 'Extensão: envia arquivos, páginas registradas e pré-preenchidas para a pasta do cliente e consulta os clientes do escritório pelo nome ou CPF.'}
          </span>
        </div>
      </Modal>

      <Modal
        open={Boolean(created)}
        title="Token criado"
        onClose={() => setCreated(null)}
        width={560}
        footer={<Button onClick={() => setCreated(null)}>Já copiei</Button>}
      >
        {created && (
          <div className="vf-stack">
            <Alert tone="warning" title="Copie agora">
              Por segurança, este token não será mostrado de novo. Se perder, revogue e crie outro.
            </Alert>
            <div className="vf-ecac-code">
              <code>{created.token}</code>
              <Button kind="secondary" size="sm" icon={<Copy />} onClick={() => void copy(created.token)}>
                Copiar
              </Button>
            </div>
            <span className="vf-muted">
              {created.scope === 'sync' ? (
                <>
                  No computador, rode <span className="vf-mono">npm run config -- --url {apiBaseUrl()} --token &lt;token&gt;</span> dentro da pasta do sincronizador. Instruções completas na{' '}
                  <Link to="/downloads">Central de downloads</Link>.
                </>
              ) : (
                <>
                  Abra a extensão Verifco no navegador, informe o endereço {apiBaseUrl()} e cole o token. Instruções na <Link to="/downloads">Central de downloads</Link>.
                </>
              )}
            </span>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(revoking)}
        title="Revogar token"
        message={`O token "${revoking?.name ?? ''}" deixa de funcionar imediatamente. O computador ou navegador que o usa precisará de um token novo.`}
        confirmLabel="Revogar"
        danger
        loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
        onClose={() => setRevoking(null)}
      />
    </Card>
  );
}
