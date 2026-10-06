import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Ban, Copy, KeyRound, Plus, RefreshCw } from 'lucide-react';
import { ECAC_RECORD_KINDS, MACHINE_TOKEN_SCOPES, optionsOf } from '@verifco/shared';
import { Alert, Button, Card, ConfirmDialog, EmptyState, Input, Loading, Modal, Select, Stat, Tag, useToast } from '../../ds';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { formatDateTime } from '../../lib/format';
import type { MachineToken, RobotOverview } from './types';
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
            <Stat label="Tokens ativos" value={o.activeTokens} hint="Extensões e sincronizadores" />
            <Stat
              label="SERPRO Integra Contador"
              value={o.serpro === 'ready' ? 'Ativo' : o.serpro === 'not_configured' ? 'Não configurado' : 'Indisponível'}
              hint={o.serpro === 'missing' ? 'Integração ausente nesta instalação' : <Link to="/admin/integracoes">Administração › Integrações</Link>}
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
            O robô reúne os dados do eCAC por três caminhos: a integração oficial <strong>SERPRO Integra Contador</strong> (procuração e caixa postal, sem depender do seu computador), a{' '}
            <strong>extensão do navegador</strong> (envia o que você abre no eCAC) e o <strong>sincronizador</strong> (guarda nos documentos do cliente os arquivos .DEC, .REC e .DBK do programa IRPF, sem ler o conteúdo; o recibo .REC marca a declaração como transmitida). Nada é simulado: sem uma dessas fontes, os painéis ficam vazios.
          </span>
          {o?.lastOfficeSync && <JobAlert job={o.lastOfficeSync} title="Sincronização geral" done={`${String(o.lastOfficeSync.result?.ok ?? 0)} de ${String(o.lastOfficeSync.result?.total ?? 0)} cliente(s) sincronizado(s).`} />}
        </div>
      </Card>

      {can('ecac.robot') && <TokensCard />}

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

function TokensCard() {
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
              ? 'Sincronizador: envia arquivos do programa IRPF e pré-preenchidas e lê a lista de clientes com procurador.'
              : 'Extensão: envia registros interpretados do eCAC e pré-preenchidas e lê a lista de clientes com procurador.'}
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
