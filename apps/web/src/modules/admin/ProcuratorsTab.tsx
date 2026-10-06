import { useState } from 'react';
import { useNavigate } from 'react-router';
import { CloudUpload, FileKey, FileSpreadsheet, Globe, KeyRound, Laptop, Pencil, Plus, Trash2 } from 'lucide-react';
import { formatCpfCnpj, isValidCpfCnpj } from '@verifco/shared';
import { Alert, Button, Card, ConfirmDialog, DropFile, EmptyState, Input, Loading, MenuItem, Modal, Select, Tag, useToast, type Tone } from '../../ds';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { formatDate } from '../../lib/format';
import { AUTH_TYPES, RowMenu, SearchBox, matches, plural, type ProcuratorRow } from './shared';

const today = () => new Date().toISOString().slice(0, 10);
const in30 = () => new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);

/** Situação do certificado para a coluna da tabela. */
function certificateInfo(p: ProcuratorRow): { tone: Tone; label: string } | null {
  if (p.authType === 'govbr') return null;
  const exp = p.certificateExpiresAt;
  if (exp && exp < today()) return { tone: 'danger', label: `Venceu em ${formatDate(exp)}` };
  if (exp && exp <= in30()) return { tone: 'warning', label: `Vence em ${formatDate(exp)}` };
  if (p.authType === 'certificate_cloud' && !p.hasCertificate) return { tone: 'danger', label: 'Arquivo não enviado' };
  if (exp) return { tone: 'success', label: `Válido até ${formatDate(exp)}` };
  return { tone: 'neutral', label: 'Validade não informada' };
}

const ACCESS_HELP = [
  {
    icon: Globe,
    title: AUTH_TYPES.govbr,
    text: 'O procurador entra com o próprio login gov.br pela extensão do navegador. Bom para começar; depende de alguém logado no dia a dia.',
  },
  {
    icon: Laptop,
    title: AUTH_TYPES.certificate_local,
    text: 'Certificado A1 ou A3 instalado no computador do escritório. A extensão usa o certificado, então o computador precisa estar ligado.',
  },
  {
    icon: CloudUpload,
    title: AUTH_TYPES.certificate_cloud,
    text: 'O arquivo .pfx do certificado A1 fica guardado cifrado no Verifco. O robô trabalha sozinho, sem depender de um computador ligado.',
  },
];

/** Aba Procuradores: quem acessa o eCAC em nome dos clientes, forma de acesso e certificado. */
export function ProcuratorsTab() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const list = useApi<ProcuratorRow[]>(['procurators'], '/procurators');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ProcuratorRow | 'new' | null>(null);
  const [certFor, setCertFor] = useState<ProcuratorRow | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'delete' | 'cert'; p: ProcuratorRow } | null>(null);
  const rows = (list.data ?? []).filter((p) => matches(search, p.name, p.cpfCnpj));
  const canEdit = can('procuration.edit');
  const canCert = can('procuration.certificate');

  const remove = useAction((p: ProcuratorRow) => api.del(`/procurators/${p.id}`), {
    success: 'Procurador excluído.',
    invalidate: [['procurators'], ['customers']],
    onSuccess: () => setConfirm(null),
  });
  const removeCert = useAction((p: ProcuratorRow) => api.del(`/procurators/${p.id}/certificate`), {
    success: 'Certificado removido.',
    invalidate: [['procurators']],
    onSuccess: () => setConfirm(null),
  });

  return (
    <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>
      <Card title="Formas de acesso ao eCAC">
        <div className="adm-access">
          {ACCESS_HELP.map((a) => (
            <div key={a.title} className="adm-access__item">
              <span className="adm-access__icon">
                <a.icon />
              </span>
              <div className="vf-stack" style={{ '--gap': '2px' } as React.CSSProperties}>
                <strong>{a.title}</strong>
                <span className="vf-text-xs vf-muted">{a.text}</span>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card
        className="adm-card"
        flush
        title="Procuradores"
        actions={
          <>
            {can('worksheet.procuration') && (list.data?.length ?? 0) > 0 && (
              <Button kind="tertiary" icon={<FileSpreadsheet />} onClick={() => navigate('/importacoes/procuracoes')}>
                Associar clientes em lote
              </Button>
            )}
            {canEdit && (
              <Button icon={<Plus />} onClick={() => setEditing('new')}>
                Novo procurador
              </Button>
            )}
          </>
        }
      >
        {(list.data?.length ?? 0) > 0 && (
          <div className="adm-toolbar">
            <SearchBox value={search} onChange={setSearch} placeholder="Buscar por nome ou CPF/CNPJ" />
          </div>
        )}
        {list.isLoading ? (
          <Loading />
        ) : list.isError ? (
          <div style={{ padding: 16 }}>
            <Alert tone="danger" title="Não foi possível carregar os procuradores." />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<KeyRound />}
            title={search ? 'Nenhum procurador encontrado' : 'Nenhum procurador cadastrado'}
            description={
              search
                ? 'Revise a busca.'
                : 'Cadastre a pessoa ou empresa que recebe as procurações eletrônicas dos clientes. Depois associe os clientes a ela, um a um ou pela importação em lote.'
            }
            action={
              !search && canEdit ? (
                <Button icon={<Plus />} onClick={() => setEditing('new')}>
                  Cadastrar procurador
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Procurador</th>
                  <th>Forma de acesso</th>
                  <th>Certificado</th>
                  <th>Clientes</th>
                  <th className="actions">
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const cert = certificateInfo(p);
                  return (
                    <tr key={p.id}>
                      <td>
                        <div className="adm-person__text">
                          <span className="vf-text-sm-bold">{p.name}</span>
                          <span className="vf-text-xs vf-muted vf-mono">{formatCpfCnpj(p.cpfCnpj)}</span>
                        </div>
                      </td>
                      <td>
                        <Tag tone={p.authType === 'certificate_cloud' ? 'primary' : 'neutral'}>{AUTH_TYPES[p.authType] ?? p.authType}</Tag>
                      </td>
                      <td>
                        {cert ? (
                          <div className="vf-stack" style={{ '--gap': '4px', alignItems: 'flex-start' } as React.CSSProperties}>
                            <Tag tone={cert.tone}>{cert.label}</Tag>
                            {p.hasCertificate && <span className="vf-text-xs vf-muted">Arquivo .pfx guardado</span>}
                          </div>
                        ) : (
                          <span className="vf-muted">Não se aplica</span>
                        )}
                      </td>
                      <td>{plural(p.customers, 'cliente', 'clientes')}</td>
                      <td className="actions">
                        {(canEdit || canCert) && (
                          <RowMenu label={`Ações de ${p.name}`}>
                            {(close) => (
                              <>
                                {canEdit && (
                                  <MenuItem icon={<Pencil />} onClick={() => (close(), setEditing(p))}>
                                    Editar
                                  </MenuItem>
                                )}
                                {canCert && (
                                  <MenuItem icon={<FileKey />} onClick={() => (close(), setCertFor(p))}>
                                    {p.hasCertificate ? 'Trocar certificado' : 'Enviar certificado A1'}
                                  </MenuItem>
                                )}
                                {canCert && p.hasCertificate && (
                                  <MenuItem icon={<Trash2 />} danger onClick={() => (close(), setConfirm({ kind: 'cert', p }))}>
                                    Remover certificado
                                  </MenuItem>
                                )}
                                {canEdit && (
                                  <MenuItem icon={<Trash2 />} danger onClick={() => (close(), setConfirm({ kind: 'delete', p }))}>
                                    Excluir procurador
                                  </MenuItem>
                                )}
                              </>
                            )}
                          </RowMenu>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && <ProcuratorForm procurator={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {certFor && <CertificateModal procurator={certFor} onClose={() => setCertFor(null)} />}

      <ConfirmDialog
        open={confirm?.kind === 'delete'}
        danger
        title="Excluir procurador"
        message={
          confirm?.p.customers
            ? `${plural(confirm.p.customers, 'cliente fica', 'clientes ficam')} sem procurador e o robô deixa de consultar o eCAC deles. O certificado guardado também é apagado.`
            : 'O procurador e o certificado guardado serão apagados.'
        }
        confirmLabel="Excluir"
        loading={remove.isPending}
        onConfirm={() => confirm && remove.mutate(confirm.p)}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === 'cert'}
        danger
        title="Remover certificado"
        message="O arquivo e a senha do certificado serão apagados. O robô para de acessar o eCAC com este certificado até que outro seja enviado."
        confirmLabel="Remover"
        loading={removeCert.isPending}
        onConfirm={() => confirm && removeCert.mutate(confirm.p)}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}

function ProcuratorForm({ procurator, onClose }: { procurator: ProcuratorRow | null; onClose: () => void }) {
  const employees = useApi<{ id: string; name: string }[]>(['employees'], '/employees');
  const [form, setForm] = useState({
    name: procurator?.name ?? '',
    cpfCnpj: procurator ? formatCpfCnpj(procurator.cpfCnpj) : '',
    authType: procurator?.authType ?? 'govbr',
    certificateExpiresAt: procurator?.certificateExpiresAt ?? '',
    userId: procurator?.userId ?? '',
  });
  const docError = form.cpfCnpj.replace(/\D/g, '').length >= 11 && !isValidCpfCnpj(form.cpfCnpj) ? 'CPF/CNPJ inválido' : undefined;
  const valid = form.name.trim().length >= 2 && isValidCpfCnpj(form.cpfCnpj);
  const save = useAction(
    () => {
      const body = {
        ...form,
        certificateExpiresAt: form.authType === 'govbr' ? null : form.certificateExpiresAt || null,
        userId: form.userId || null,
      };
      return procurator ? api.put(`/procurators/${procurator.id}`, body) : api.post('/procurators', body);
    },
    { success: procurator ? 'Procurador atualizado.' : 'Procurador cadastrado.', invalidate: [['procurators']], onSuccess: onClose },
  );
  return (
    <Modal
      open
      title={procurator ? 'Editar procurador' : 'Novo procurador'}
      onClose={onClose}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <Input label="Nome" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus maxLength={200} />
        <Input
          label="CPF ou CNPJ do procurador"
          required
          inputMode="numeric"
          value={form.cpfCnpj}
          onChange={(e) => setForm({ ...form, cpfCnpj: e.target.value })}
          error={docError}
          help="É o documento que aparece na procuração eletrônica feita pelo cliente no eCAC."
        />
        <Select
          label="Forma de acesso"
          value={form.authType}
          onChange={(e) => setForm({ ...form, authType: e.target.value as ProcuratorRow['authType'] })}
          options={Object.entries(AUTH_TYPES).map(([value, label]) => ({ value, label }))}
        />
        {form.authType !== 'govbr' && (
          <Input
            label="Validade do certificado"
            type="date"
            value={form.certificateExpiresAt}
            onChange={(e) => setForm({ ...form, certificateExpiresAt: e.target.value })}
            help="Avisamos na lista quando faltar menos de 30 dias."
          />
        )}
        <Select
          label="Colaborador vinculado"
          placeholder="Nenhum"
          value={form.userId}
          onChange={(e) => setForm({ ...form, userId: e.target.value })}
          options={(employees.data ?? []).map((u) => ({ value: u.id, label: u.name }))}
          help="Opcional. Quando o procurador é alguém da equipe, ele vê estes dados na própria conta."
        />
        {form.authType === 'certificate_cloud' && !procurator?.hasCertificate && (
          <Alert>Depois de salvar, use “Enviar certificado A1” no menu do procurador para mandar o arquivo .pfx.</Alert>
        )}
      </div>
    </Modal>
  );
}

function CertificateModal({ procurator, onClose }: { procurator: ProcuratorRow; onClose: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const save = useAction(() => api.upload(`/procurators/${procurator.id}/certificate`, file!, { password }), {
    success: 'Certificado guardado com segurança.',
    invalidate: [['procurators']],
    onSuccess: onClose,
  });
  return (
    <Modal
      open
      title={procurator.hasCertificate ? 'Trocar certificado A1' : 'Enviar certificado A1'}
      onClose={onClose}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!file || !password} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Guardar certificado
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <p className="vf-muted">
          Certificado de <strong>{procurator.name}</strong>. O arquivo e a senha ficam cifrados e são usados só pelo robô para acessar o eCAC. Ao enviar, a forma de acesso passa a ser “{AUTH_TYPES.certificate_cloud}”.
        </p>
        <DropFile
          accept=".pfx,.p12"
          title={file ? file.name : 'Arraste o arquivo .pfx ou .p12'}
          hint={file ? 'Clique em Selecionar para trocar o arquivo' : 'Somente certificado A1 (arquivo)'}
          onFiles={(files) => {
            const f = files[0];
            if (!f) return;
            if (!/\.(pfx|p12)$/i.test(f.name)) return toast.error('Envie o arquivo .pfx ou .p12 do certificado A1.');
            setFile(f);
          }}
        />
        <Input label="Senha de instalação do certificado" type="password" autoComplete="off" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
    </Modal>
  );
}
