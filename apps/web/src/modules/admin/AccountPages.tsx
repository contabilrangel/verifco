import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Bell, KeyRound, LogOut, Save, ShieldCheck } from 'lucide-react';
import { formatCpfCnpj, type PermissionCategory } from '@verifco/shared';
import { Alert, Avatar, Button, Card, ConfirmDialog, Input, Loading, Switch, Tag } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { api, setToken } from '../../lib/api';
import { useAuth, type Me } from '../../lib/auth';
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
          <ProcuratorCard userId={me.user.id} />
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

/** Se o usuário é procurador cadastrado, mostra a forma de acesso e o certificado. */
function ProcuratorCard({ userId }: { userId: string }) {
  const { can } = useAuth();
  const list = useApi<ProcuratorRow[]>(['procurators'], '/procurators');
  const mine = (list.data ?? []).filter((p) => p.userId === userId);
  if (!mine.length) return null;
  return (
    <Card title="Você como procurador">
      <div className="vf-stack">
        {mine.map((p) => (
          <div key={p.id} className="vf-stack" style={{ '--gap': '4px' } as React.CSSProperties}>
            <span className="vf-text-sm-bold">
              {p.name} · <span className="vf-mono">{formatCpfCnpj(p.cpfCnpj)}</span>
            </span>
            <span className="vf-inline">
              <Tag tone={p.authType === 'certificate_cloud' ? 'primary' : 'neutral'}>{AUTH_TYPES[p.authType]}</Tag>
              {p.hasCertificate && <Tag tone="success">Certificado guardado</Tag>}
              {p.certificateExpiresAt && <span className="vf-text-xs vf-muted">Validade {formatDate(p.certificateExpiresAt)}</span>}
            </span>
            <span className="vf-text-xs vf-muted">{p.customers} cliente(s) associados.</span>
          </div>
        ))}
        {can('procuration.edit', 'procuration.certificate') && (
          <Link to="/admin/procuradores" className="vf-text-sm-bold">
            Gerenciar em Administração › Procuradores
          </Link>
        )}
      </div>
    </Card>
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

/** Preferências pessoais: notificações e revogação de sessões. */
export function AccountPreferencesPage() {
  const { me, refresh } = useAuth();
  const [open, setOpen] = useState(false);
  const { run, pending } = useLogoutAll();
  const enabled = me?.user.notificationPrefs?.enabled !== false;
  const save = useAction((v: boolean) => api.put('/auth/preferences', { notificationsEnabled: v }), {
    success: 'Preferência salva.',
    onSuccess: () => void refresh(),
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
                  title="Receber notificações nesta conta"
                  help="Avisos no sino sobre documentos enviados por clientes, checklists concluídos, mudanças no eCAC e tarefas finalizadas. Vale para todos os dispositivos."
                />
              }
              checked={save.isPending ? !enabled : enabled}
              disabled={save.isPending}
              onChange={(v) => save.mutate(v)}
            />
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
    </>
  );
}
