import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, HardDriveDownload, ShieldCheck, XCircle } from 'lucide-react';
import { Alert, Button, Card, ConfirmDialog, EmptyState, Loading, Progress, Tag, useToast } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/hooks';
import { formatDateTime } from '../../lib/format';
import { errorMessage } from './ui';

interface BackupJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  error: string | null;
  result: { fileId?: string; filename?: string; size?: number; tables?: Record<string, number>; files?: number } | null;
  createdAt: string;
  finishedAt: string | null;
}

const INCLUDED = [
  'Clientes, grupos, procuradores e colaboradores (sem senhas)',
  'Declarações e todas as linhas (rendimentos, pagamentos, bens, dívidas)',
  'Checklist, documentos enviados e pendências',
  'Orçamentos, faturamentos, parcelas, recibos e DARFs',
  'Templates, envios e mensagens',
  'Radar, conversas e análises de IA, holding, livro caixa e copiloto',
  'Arquivos enviados ao Verifco e PDFs gerados',
];
const EXCLUDED = [
  'Senhas de usuários e tokens de acesso',
  'Login e senha do eCAC/gov.br e senha do INSS dos clientes',
  'Certificados digitais (.pfx) e suas senhas',
  'Chaves de API das integrações (Asaas, Omie, WhatsApp, IA)',
  'Backups anteriores e a fila interna de tarefas',
];

const size = (bytes?: number) => (!bytes ? '—' : bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export function BackupPage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const allowed = can('backup.download');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const list = useApi<BackupJob[]>(['backups'], allowed ? '/backups' : null, { refetchInterval: 2000 });
  const running = (list.data ?? []).some((j) => j.status === 'queued' || j.status === 'running');

  const generate = async () => {
    setBusy(true);
    try {
      await api.post('/backups');
      setConfirm(false);
      toast.info('Backup em preparação. Você recebe uma notificação quando ficar pronto.');
      await qc.invalidateQueries({ queryKey: ['backups'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!allowed) return <EmptyState title="Sem acesso" description="Seu perfil não tem permissão para baixar backups." />;

  return (
    <>
      <PageHeader
        title="Backup do escritório"
        description="Gere um arquivo .zip com todos os dados e arquivos do escritório para guardar fora do Verifco."
        crumbs={[{ label: 'Início', to: '/' }, { label: 'Backup' }]}
        actions={
          <Button icon={<HardDriveDownload />} loading={busy} disabled={running} onClick={() => setConfirm(true)}>
            Gerar backup
          </Button>
        }
      />
      <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
        <div className="vf-grid">
          <Card title={<span className="vf-inline"><CheckCircle2 size={18} color="var(--color-success)" /> O que entra no backup</span>}>
            <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {INCLUDED.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            <p className="vf-text-xs vf-muted" style={{ marginTop: 12 }}>
              Os dados vão em JSON, um arquivo por tabela (pasta “dados”), e os arquivos na pasta “arquivos”, com um LEIAME.txt explicando o conteúdo.
            </p>
          </Card>
          <Card title={<span className="vf-inline"><XCircle size={18} color="var(--color-danger)" /> O que não entra (credenciais)</span>}>
            <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {EXCLUDED.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            <div style={{ marginTop: 12 }}>
              <Alert tone="warning">O arquivo contém dados pessoais e fiscais dos clientes (LGPD): guarde em local seguro e com acesso restrito.</Alert>
            </div>
          </Card>
        </div>

        <Card flush title="Backups gerados">
          {list.isLoading ? (
            <Loading />
          ) : !(list.data ?? []).length ? (
            <EmptyState icon={<ShieldCheck />} title="Nenhum backup gerado" description="Clique em “Gerar backup” para montar o primeiro arquivo." />
          ) : (
            <div className="vf-table-wrap" style={{ marginTop: 16 }}>
              <table className="vf-table">
                <thead>
                  <tr>
                    <th>Solicitado em</th>
                    <th>Situação</th>
                    <th className="num">Registros</th>
                    <th className="num">Arquivos</th>
                    <th className="num">Tamanho</th>
                    <th className="actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {list.data!.map((j) => {
                    const records = j.result?.tables ? Object.values(j.result.tables).reduce((a, b) => a + b, 0) : null;
                    return (
                      <tr key={j.id}>
                        <td>{formatDateTime(j.createdAt)}</td>
                        <td style={{ minWidth: 180 }}>
                          {j.status === 'done' ? (
                            <Tag tone="success">Pronto · {formatDateTime(j.finishedAt)}</Tag>
                          ) : j.status === 'failed' ? (
                            <Tag tone="danger">Falhou: {j.error}</Tag>
                          ) : (
                            <div className="vf-stack" style={{ '--gap': '4px' } as React.CSSProperties}>
                              <Tag tone="warning">{j.status === 'queued' ? 'Na fila' : 'Gerando'}</Tag>
                              <Progress value={j.progress} />
                            </div>
                          )}
                        </td>
                        <td className="num">{records?.toLocaleString('pt-BR') ?? '—'}</td>
                        <td className="num">{j.result?.files ?? '—'}</td>
                        <td className="num">{size(j.result?.size)}</td>
                        <td className="actions">
                          <Button
                            kind="secondary"
                            size="sm"
                            icon={<Download />}
                            disabled={j.status !== 'done'}
                            onClick={() => void api.download(`/backups/${j.id}/download`, j.result?.filename ?? 'backup.zip').catch((e) => toast.error(errorMessage(e)))}
                          >
                            Baixar
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Gerar backup"
        message="O Verifco vai montar um .zip com os dados e arquivos do escritório (sem credenciais). Pode levar alguns minutos."
        confirmLabel="Gerar backup"
        loading={busy}
        onConfirm={() => void generate()}
        onClose={() => setConfirm(false)}
      />
    </>
  );
}
