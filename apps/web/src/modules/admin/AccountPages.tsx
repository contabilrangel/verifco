import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Bell, BellOff, KeyRound, LogOut, Save, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { formatCpfCnpj, type PermissionCategory } from '@verifco/shared';
import { Alert, Avatar, Button, Card, ConfirmDialog, DropFile, Input, Loading, Select, Switch, Tag, useToast } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { api, setToken } from '../../lib/api';
import { useAuth, type Me } from '../../lib/auth';
import { browserNotificationsSupported, getDeviceId } from '../../lib/deviceNotifications';
import { useAction, useApi } from '../../lib/hooks';
import { formatDate } from '../../lib/format';
import { AUTH_TYPES, SettingLabel, type ProcuratorRow } from './shared';

const crumbs = (label: string) => [{ label: 'Início', to: '/' }, { label: 'Minha conta', to: '/conta' }, ...(label === 'Minha conta' ? [] : [{ label }])];

/** Detalhes da conta: dados pessoais, função e permissões, senha e sessões. */
export function AccountPage() {
  const { me } = useAuth();
  if (!me) return <Loading />;
  return (
    <>
      <PageHeader title="Minha conta" description="Seus dados de acesso, a função que você tem no escritório e a segurança da conta." crumbs={crumbs('Minha conta')} />
      <div className="adm-split">
        <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>
          <ProfileCard me={me} />
          <PermissionsCard me={me} />
        </div>
        <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>
          <PasswordCard />
          <ProcuratorCard />
          <SessionsCard />
        </div>
      </div>
    </>
  );
}

function ProfileCard({ me }: { me: Me }) {
  const { refresh } = useAuth();
  const [name, setName] = useState(me.user.name);
  useEffect(() => setName(me.user.name), [me.user.name]);
  const save = useAction(() => api.put('/account/profile', { name }), { success: 'Nome atualizado.', onSuccess: () => void refresh() });
  const changed = name.trim() !== me.user.name && name.trim().length >= 2;
  return (
    <Card title="Seus dados">
      <div className="vf-stack">
        <div className="adm-person">
          <Avatar name={me.user.name} size={48} />
          <div className="adm-person__text">
            <span className="vf-text-md-bold">{me.user.name}</span>
            <span className="vf-muted">{me.office?.name}</span>
          </div>
        </div>
        <div className="vf-grid" style={{ '--cols': 2 } as React.CSSProperties}>
          <Input label="Nome" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} error={name.trim().length < 2 ? 'Informe o nome' : undefined} />
          <Input label="E-mail de acesso" value={me.user.email} disabled help="Para trocar o e-mail, peça a quem administra os colaboradores." />
        </div>
        <div className="vf-inline vf-end">
          <Button icon={<Save />} disabled={!changed} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Salvar
          </Button>
        </div>
      </div>
    </Card>
  );
}

function PermissionsCard({ me }: { me: Me }) {
  const catalog = useApi<PermissionCategory[]>(['permissions-catalog'], '/permissions/catalog');
  const granted = new Set(me.permissions);
  const withAccess = (catalog.data ?? []).map((c) => ({ ...c, on: c.permissions.filter((p) => granted.has(p.key)) }));
  const without = withAccess.filter((c) => c.on.length === 0);
  return (
    <Card
      className="adm-card"
      title="Função e permissões"
      actions={<Tag tone={me.user.isOwner ? 'highlight' : 'primary'} icon={<ShieldCheck size={14} />}>{me.user.isOwner ? 'Dono da conta' : (me.role?.name ?? 'Sem função')}</Tag>}
    >
      {catalog.isLoading ? (
        <Loading />
      ) : catalog.isError ? (
        <Alert tone="danger" title="Não foi possível carregar o catálogo de permissões." />
      ) : (
        <div className="vf-stack">
          <p className="vf-muted vf-text-xs">
            {me.user.isOwner
              ? 'Como dono da conta, você tem acesso a tudo.'
              : 'Somente leitura. As permissões vêm da sua função; quem administra o escritório pode alterá-las em Administração › Funções.'}
          </p>
          {withAccess
            .filter((c) => c.on.length > 0)
            .map((c) => (
              <div key={c.id} className="vf-stack" style={{ '--gap': '6px' } as React.CSSProperties}>
                <div className="vf-inline vf-between">
                  <span className="vf-text-sm-bold">{c.label}</span>
                  <span className="vf-text-xs vf-muted">
                    {c.on.length} de {c.permissions.length}
                  </span>
                </div>
                <div className="adm-perm-tags">
                  {c.on.map((p) => (
                    <Tag key={p.key}>{p.label}</Tag>
                  ))}
                </div>
              </div>
            ))}
          {without.length > 0 && (
            <p className="vf-text-xs vf-muted">
              <strong>Sem acesso:</strong> {without.map((c) => c.label).join(', ')}.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function PasswordCard() {
  const { refresh } = useAuth();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const mismatch = form.confirm.length > 0 && form.next !== form.confirm;
  const short = form.next.length > 0 && form.next.length < 8;
  const valid = form.current.length > 0 && form.next.length >= 8 && form.next === form.confirm;
  const save = useAction(() => api.post<{ token: string }>('/auth/change-password', { currentPassword: form.current, newPassword: form.next }), {
    success: 'Senha alterada. As outras sessões foram encerradas.',
    onSuccess: (r) => {
      setToken(r.token);
      setForm({ current: '', next: '', confirm: '' });
      void refresh();
    },
  });
  return (
    <Card title="Senha">
      <form
        className="vf-stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate(undefined);
        }}
      >
        <Input label="Senha atual" type="password" autoComplete="current-password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
        <Input
          label="Nova senha"
          type="password"
          autoComplete="new-password"
          value={form.next}
          onChange={(e) => setForm({ ...form, next: e.target.value })}
          error={short ? 'Use ao menos 8 caracteres' : undefined}
          help="Ao menos 8 caracteres."
        />
        <Input
          label="Confirme a nova senha"
          type="password"
          autoComplete="new-password"
          value={form.confirm}
          onChange={(e) => setForm({ ...form, confirm: e.target.value })}
          error={mismatch ? 'As senhas não conferem' : undefined}
        />
        <div className="vf-inline vf-end">
          <Button type="submit" icon={<KeyRound />} disabled={!valid} loading={save.isPending}>
            Alterar senha
          </Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * Se o usuário é procurador cadastrado: forma de autenticação e certificado A1, que ele mesmo
 * configura aqui (sem precisar das permissões de Administração › Procuradores).
 */
function ProcuratorCard() {
  const { can } = useAuth();
  const list = useApi<ProcuratorRow[]>(['account-procurator'], '/account/procurator');
  const mine = list.data ?? [];
  if (!mine.length) return null;
  return (
    <Card title="Você como procurador">
      <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>
        {mine.map((p) => (
          <OwnProcurator key={p.id} p={p} />
        ))}
        {can('procuration.edit', 'procuration.certificate') && (
          <Link to="/admin/procuradores" className="vf-text-sm-bold">
            Gerenciar todos em Administração › Procuradores
          </Link>
        )}
      </div>
    </Card>
  );
}

function OwnProcurator({ p }: { p: ProcuratorRow }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const invalidate = [['account-procurator'], ['procurators']];
  const authType = useAction((v: ProcuratorRow['authType']) => api.patch(`/procurators/${p.id}/auth-type`, { authType: v }), {
    success: 'Forma de autenticação atualizada.',
    invalidate,
  });
  const upload = useAction(() => api.upload(`/procurators/${p.id}/certificate`, file!, { password }), {
    success: 'Certificado guardado com segurança.',
    invalidate,
    onSuccess: () => {
      setFile(null);
      setPassword('');
    },
  });
  const remove = useAction(() => api.del(`/procurators/${p.id}/certificate`), {
    success: 'Certificado removido.',
    invalidate,
    onSuccess: () => setConfirmRemove(false),
  });
  return (
    <div className="vf-stack">
      <div className="vf-stack" style={{ '--gap': '4px' } as React.CSSProperties}>
        <span className="vf-text-sm-bold">
          {p.name} · <span className="vf-mono">{formatCpfCnpj(p.cpfCnpj)}</span>
        </span>
        <span className="vf-inline">
          {p.hasCertificate ? <Tag tone="success">Certificado guardado</Tag> : <Tag>Sem certificado na nuvem</Tag>}
          {p.certificateExpiresAt && <span className="vf-text-xs vf-muted">Validade {formatDate(p.certificateExpiresAt)}</span>}
        </span>
        <span className="vf-text-xs vf-muted">{p.customers} cliente(s) associados.</span>
      </div>
      <Select
        label="Forma de autenticação no eCAC"
        value={p.authType}
        disabled={authType.isPending}
        onChange={(e) => authType.mutate(e.target.value as ProcuratorRow['authType'])}
        options={(Object.keys(AUTH_TYPES) as ProcuratorRow['authType'][]).map((k) => ({ value: k, label: AUTH_TYPES[k] }))}
      />
      {p.authType === 'certificate_cloud' && (
        <div className="vf-stack">
          <p className="vf-muted vf-text-xs">O arquivo e a senha ficam cifrados e são usados só pelo robô para acessar o eCAC dos clientes com procuração.</p>
          <DropFile
            accept=".pfx,.p12"
            title={file ? file.name : p.hasCertificate ? 'Arraste um novo .pfx ou .p12 para trocar' : 'Arraste o arquivo .pfx ou .p12'}
            hint={file ? 'Clique em Selecionar para trocar o arquivo' : 'Somente certificado A1 (arquivo)'}
            onFiles={(files) => {
              const f = files[0];
              if (!f) return;
              if (!/\.(pfx|p12)$/i.test(f.name)) return toast.error('Envie o arquivo .pfx ou .p12 do certificado A1.');
              setFile(f);
            }}
          />
          <Input label="Senha de instalação do certificado" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          <div className="vf-inline vf-end">
            {p.hasCertificate && (
              <Button kind="tertiary" icon={<Trash2 />} onClick={() => setConfirmRemove(true)}>
                Remover certificado
              </Button>
            )}
            <Button icon={<Upload />} disabled={!file || !password} loading={upload.isPending} onClick={() => upload.mutate(undefined)}>
              {p.hasCertificate ? 'Trocar certificado' : 'Salvar certificado'}
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmRemove}
        danger
        title="Remover certificado"
        message="O robô deixa de acessar o eCAC com este certificado até que um novo seja enviado."
        confirmLabel="Remover"
        loading={remove.isPending}
        onConfirm={() => remove.mutate(undefined)}
        onClose={() => setConfirmRemove(false)}
      />
    </div>
  );
}

function SessionsCard() {
  const [open, setOpen] = useState(false);
  const { run, pending } = useLogoutAll();
  return (
    <Card title="Sessões">
      <div className="vf-stack">
        <p className="vf-muted">Saia de todos os navegadores e dispositivos em que sua conta está aberta, inclusive este. Útil se você usou um computador compartilhado.</p>
        <div>
          <Button kind="secondary" icon={<LogOut />} onClick={() => setOpen(true)}>
            Sair de todas as sessões
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={open}
        danger
        title="Sair de todas as sessões"
        message="Você será desconectado em todos os dispositivos, inclusive neste, e precisará entrar de novo."
        confirmLabel="Sair de todas"
        loading={pending}
        onConfirm={run}
        onClose={() => setOpen(false)}
      />
    </Card>
  );
}

/** Encerra todas as sessões (o token atual também deixa de valer) e volta para o login. */
function useLogoutAll() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const action = useAction(() => api.post('/auth/logout-all'), {
    onSuccess: () => {
      logout();
      navigate('/entrar', { replace: true });
    },
  });
  return { run: () => action.mutate(undefined), pending: action.isPending };
}

/** Preferências pessoais: notificações (geral e por navegador) e revogação de sessões. */
export function AccountPreferencesPage() {
  const { me, refresh } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const { run, pending } = useLogoutAll();
  const enabled = me?.user.notificationPrefs?.enabled !== false;
  const save = useAction((v: boolean) => api.put('/auth/preferences', { notificationsEnabled: v }), {
    success: 'Preferência salva.',
    onSuccess: () => void refresh(),
  });
  const supported = browserNotificationsSupported();
  const deviceId = getDeviceId();
  const devices = me?.user.notificationPrefs?.devices ?? [];
  const thisDevice = supported && devices.includes(deviceId) && Notification.permission === 'granted';
  const device = useAction((on: boolean) => (on ? api.post('/account/notification-devices', { deviceId }) : api.del(`/account/notification-devices/${deviceId}`)), {
    success: 'Preferência deste navegador salva.',
    onSuccess: () => void refresh(),
  });
  const toggleDevice = async (on: boolean) => {
    // o navegador pede a permissão de notificação na primeira vez
    if (on && (await Notification.requestPermission()) !== 'granted') {
      return toast.error('O navegador bloqueou as notificações. Libere nas configurações do site e tente de novo.');
    }
    device.mutate(on);
  };
  const revokeAll = useAction(() => api.del('/account/notification-devices'), {
    success: 'Notificações desligadas em todos os navegadores.',
    onSuccess: () => {
      setRevokeOpen(false);
      void refresh();
    },
  });
  if (!me) return <Loading />;
  return (
    <>
      <PageHeader title="Preferências" description="Como o Verifco avisa você e o controle das sessões abertas." crumbs={crumbs('Preferências')} />
      <div className="adm-two">
        <Card title="Notificações" actions={<Bell size={20} className="vf-muted" />}>
          <div className="vf-stack">
            <Switch
              label={
                <SettingLabel
                  title="Configuração global"
                  help="Avisos no sino sobre documentos enviados por clientes, checklists concluídos, mudanças no eCAC e tarefas finalizadas. Desligado, nenhum dispositivo recebe avisos."
                />
              }
              checked={save.isPending ? !enabled : enabled}
              disabled={save.isPending}
              onChange={(v) => save.mutate(v)}
            />
            <Switch
              label={
                <SettingLabel
                  title="Este navegador"
                  help={
                    supported
                      ? 'Controla as notificações deste dispositivo: os avisos do sino aparecem também como notificação do sistema enquanto o Verifco estiver aberto em alguma aba.'
                      : 'Este navegador não oferece notificações do sistema.'
                  }
                />
              }
              checked={device.isPending ? !thisDevice : thisDevice}
              disabled={!supported || !enabled || device.isPending}
              onChange={(v) => void toggleDevice(v)}
            />
            <div className="vf-inline vf-between" style={{ alignItems: 'center' }}>
              <span className="vf-text-xs vf-muted">
                {devices.length ? `${devices.length} navegador(es) com notificações ligadas.` : 'Nenhum navegador com notificações ligadas.'}
              </span>
              <Button kind="secondary" size="sm" icon={<BellOff />} disabled={!devices.length} onClick={() => setRevokeOpen(true)}>
                Revogar todas notificações
              </Button>
            </div>
          </div>
        </Card>
        <Card title="Sessões e acesso" actions={<LogOut size={20} className="vf-muted" />}>
          <div className="vf-stack">
            <p className="vf-muted">Revogue o acesso de todos os dispositivos conectados à sua conta, inclusive este navegador.</p>
            <div>
              <Button kind="danger" icon={<LogOut />} onClick={() => setOpen(true)}>
                Revogar todas as sessões
              </Button>
            </div>
          </div>
        </Card>
      </div>
      <ConfirmDialog
        open={open}
        danger
        title="Revogar todas as sessões"
        message="Todos os dispositivos, inclusive este, serão desconectados. Você precisará entrar de novo com e-mail e senha."
        confirmLabel="Revogar"
        loading={pending}
        onConfirm={run}
        onClose={() => setOpen(false)}
      />
      <ConfirmDialog
        open={revokeOpen}
        danger
        title="Revogar todas as notificações"
        message="As notificações do sistema serão desligadas em todos os navegadores. Os avisos continuam no sino, e as sessões seguem abertas."
        confirmLabel="Revogar"
        loading={revokeAll.isPending}
        onConfirm={() => revokeAll.mutate(undefined)}
        onClose={() => setRevokeOpen(false)}
      />
    </>
  );
}
