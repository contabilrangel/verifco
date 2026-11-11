import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { Activity, Building2, FileCheck2, KeyRound, LayoutDashboard, Lock, LogOut, Mail, Plus, Settings, ShieldCheck, Sparkles, Users, History, Check, PlugZap } from 'lucide-react';
import { AI_PROVIDERS, CONTRACT_STATUS, aiProviderDef, contractSituation, todayIso, formatDateTimeBr, type AiProviderKey } from '@verifco/shared';
import { Alert, Button, Card, Checkbox, ConfirmDialog, Input, Loading, PasswordInput, Select, Tag } from '../../ds';
import { AuthFooter, AuthHeading, AuthLayout } from '../../app/AuthLayout';
import { ApiError, errorMessage } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { platformRequest as request, platformToken, savePlatformToken } from './client';
import { AccountPage, DataState, HealthAlerts, OfficeDetailCard, OperationPage, SettingsPage, useData, type OverviewData, type PageProps } from './PlatformOps';
import './platform.css';

interface Account { id: string; name: string; email: string; role: 'owner' | 'developer'; isActive?: boolean; lastLoginAt?: string | null; twoFactor?: boolean; twoFactorEnabled?: boolean }
interface Office { id: string; name: string; email: string | null; city: string | null; state: string | null; customers: number; collaborators: number; blockedAt?: string | null; lastLoginAt?: string | null; contractExpiresAt?: string | null }
interface Connection { id: string; provider: AiProviderKey; name: string; model: string; baseUrl: string; enabled: boolean; keyConfigured: boolean; supportsImages: boolean; pdf: boolean; status: string; lastTestAt: string | null }
interface AiData { connections: Connection[]; defaultAiId: string | null; environmentConfigured: boolean }
interface Contract { id: string; officeId: string; officeName?: string; name: string; plan: string; declarationLimit: number | null; year: number; startsAt: string; expiresAt: string; hasBackup: boolean; status: string }

export function PlatformPanel() {
  const [token, setToken] = useState(platformToken);
  const [me, setMe] = useState<Account | null>(null); const [loading, setLoading] = useState(Boolean(token)); const [error, setError] = useState('');
  useEffect(() => {
    const expire = () => { setToken(null); setMe(null); };
    window.addEventListener('verifco.platform.expired', expire);
    return () => window.removeEventListener('verifco.platform.expired', expire);
  }, []);
  useEffect(() => { let live = true;
    if (!token) { setMe(null); setLoading(false); return; }
    setLoading(true);
    request<Account>('/me').then((user) => { if (live) { setMe(user); setError(''); } })
      .catch((e) => { if (live) setError(errorMessage(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [token]);
  if (loading) return <Loading label="Abrindo a administração do sistema..." />;
  if (!me) return <PlatformLogin error={error} onLogin={(value) => { savePlatformToken(value); setToken(value); }} />;
  return <PlatformShell me={me} onToken={setToken} onChange={() => void request<Account>('/me').then(setMe).catch(() => {})} logout={async () => {
    // encerra a sessão local mesmo se o POST falhar (máquina compartilhada): o token sai daqui
    try { await request('/logout', 'POST', {}); }
    catch { /* a sessão local é encerrada de qualquer forma */ }
    finally { savePlatformToken(null); setToken(null); setMe(null); }
  }} error={error} />;
}

function PlatformLogin({ onLogin, error }: { onLogin: (token: string) => void; error: string }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [failure, setFailure] = useState(''); const [busy, setBusy] = useState(false);
  // conta com verificação em duas etapas: a senha foi aceita e falta o código
  const [needsCode, setNeedsCode] = useState(false); const [code, setCode] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setFailure('');
    try { onLogin((await request<{ token: string }>('/login', 'POST', { email, password, ...(needsCode ? { code } : {}) })).token); }
    catch (e) {
      const twoFactor = e instanceof ApiError && (e.details as { code?: string } | undefined)?.code === 'two_factor_required';
      if (twoFactor && !needsCode) setNeedsCode(true);
      else { setFailure(errorMessage(e)); if (!twoFactor) { setNeedsCode(false); setCode(''); } }
    } finally { setBusy(false); }
  }
  return <AuthLayout
    variant="system"
    badge={<><ShieldCheck aria-hidden /> Administração do sistema</>}
    eyebrow="Painel global da equipe Verifco"
    title="Um lugar para administrar a plataforma."
    lead="Escritórios, contratos, inteligência artificial e operação do Verifco."
    features={[
      { icon: <Building2 />, title: 'Administração global', text: 'Escritórios, planos e contratos.' },
      { icon: <Sparkles />, title: 'Conexões de IA', text: 'Provedores e modelos usados pelos escritórios.' },
      { icon: <ShieldCheck />, title: 'Acesso restrito', text: 'Exclusivo da equipe do sistema.' },
    ]}
  >
    <form className="auth-page__form" onSubmit={submit}>
      <AuthHeading icon={<ShieldCheck />} title="Entrar na administração" subtitle="Use sua conta de proprietário ou desenvolvedor do sistema." />
      {(failure || error) && <Alert tone="danger" title={failure || error} />}
      <div className="auth-page__fields">
        <Input label="E-mail do sistema" type="email" autoComplete="username" required icon={<Mail />} value={email} onChange={(e) => setEmail(e.target.value)} />
        <PasswordInput label="Senha" autoComplete="current-password" required icon={<Lock />} value={password} onChange={(e) => setPassword(e.target.value)} />
        {needsCode && <Input label="Código do aplicativo autenticador" help="6 dígitos, ou um dos seus códigos de recuperação." autoComplete="one-time-code" required autoFocus icon={<KeyRound />} value={code} onChange={(e) => setCode(e.target.value)} />}
      </div>
      <Button type="submit" loading={busy} block>{needsCode ? 'Confirmar código' : 'Entrar no sistema'}</Button>
      <AuthFooter><span>É do escritório? <Link to="/entrar">Acessar o painel do contador</Link></span></AuthFooter>
    </form>
  </AuthLayout>;
}

const TABS = [
  { path: '', label: 'Visão geral', icon: LayoutDashboard },
  { path: 'escritorios', label: 'Escritórios', icon: Building2 },
  { path: 'contratos', label: 'Planos e contratos', icon: FileCheck2 },
  { path: 'operacao', label: 'Operação', icon: Activity },
  { path: 'ia', label: 'Inteligência artificial', icon: Sparkles, owner: true },
  { path: 'equipe', label: 'Equipe do sistema', icon: Users, owner: true },
  { path: 'configuracoes', label: 'Configurações', icon: Settings },
  { path: 'auditoria', label: 'Auditoria', icon: History },
  { path: 'conta', label: 'Minha conta', icon: KeyRound },
];
const SUBTITLES: Record<string, string> = {
  ia: 'Conecte serviços, escolha os modelos e disponibilize a IA para os escritórios.',
  operacao: 'Fila de tarefas, falhas e o e-mail que entrega convites e redefinições de senha.',
  configuracoes: 'Cadastro de novos escritórios, avaliação gratuita, suporte e termos de uso.',
  conta: 'Sua senha de acesso ao painel do sistema.',
};
function PlatformShell({ me, logout, error, onToken, onChange }: { me: Account; logout: () => Promise<void>; error: string; onToken: (token: string) => void; onChange: () => void }) {
  const location = useLocation(); const tab = location.pathname.replace(/^\/sistema\/?/, '').replace(/\/$/, '');
  const owner = me.role === 'owner'; const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [confirmation, setConfirmation] = useState<{ title: string; run: () => Promise<void> } | null>(null);
  async function action(fn: () => Promise<unknown>, message = 'Alteração salva.') {
    setBusy(true); setNotice(null);
    try { await fn(); setNotice({ error: false, text: message }); }
    catch (e) { setNotice({ error: true, text: errorMessage(e) }); } finally { setBusy(false); setRevision((r) => r + 1); }
  }
  const props = { owner, revision, busy, action, confirm: (title: string, fn: () => Promise<unknown>, message?: string) => setConfirmation({ title, run: () => action(fn, message) }) };
  const selected = TABS.find((t) => t.path === tab && (!t.owner || owner));
  return <div className="vf-platform">
    <aside className="vf-platform-sidebar">
      <div className="vf-platform-brand"><img className="vf-platform-brand__logo" src="/verifco-logo-negativo.svg" alt="Verifco" /></div><span className="vf-platform-caption">Administração do sistema</span>
      <nav aria-label="Administração global">{TABS.filter((t) => !t.owner || owner).map((t) => <NavLink end to={`/sistema${t.path ? '/' + t.path : ''}`} key={t.path}>
        <t.icon size={19} />{t.label}</NavLink>)}</nav>
      <div className="vf-platform-account"><strong>{me.name}</strong><span>{owner ? 'Proprietário' : 'Desenvolvedor'}</span>
        <Button kind="tertiary" icon={<LogOut size={16} />} onClick={logout}>Sair do sistema</Button></div>
    </aside>
    <div className="vf-platform-body"><header className="vf-platform-header"><Tag tone="primary">Painel global</Tag><span>{me.email}</span></header>
      <main className="vf-platform-content"><div className="vf-platform-page-title"><p>VERIFCO / SISTEMA</p><h1>{selected?.label ?? 'Página indisponível'}</h1>
        <span>{SUBTITLES[tab] ?? 'Administração central para o proprietário e a equipe de desenvolvimento.'}</span></div>
        {error && <Alert tone="danger" title={error} />}
        {notice && <Alert tone={notice.error ? 'danger' : 'success'} title={notice.text} />}
        {!selected ? <Alert tone="warning" title="Esta página não está disponível para sua conta." />
          : tab === 'ia' ? <AiPage {...props} /> : tab === 'escritorios' ? <OfficesPage {...props} /> : tab === 'contratos' ? <ContractsPage {...props} />
          : tab === 'operacao' ? <OperationPage {...props} /> : tab === 'configuracoes' ? <SettingsPage {...props} /> : tab === 'conta' ? <AccountPage p={props} me={me} onToken={onToken} onChange={onChange} />
          : tab === 'equipe' ? <TeamPage {...props} me={me} /> : tab === 'auditoria' ? <AuditPage revision={revision} /> : <Overview revision={revision} />}
      </main>
    </div>
    <ConfirmDialog open={Boolean(confirmation)} title={confirmation?.title ?? ''} message="Confirme para concluir esta alteração." onClose={() => setConfirmation(null)}
      onConfirm={async () => { const current = confirmation; setConfirmation(null); await current?.run(); }} />
  </div>;
}
function Overview({ revision }: { revision: number }) {
  const { data, error } = useData<OverviewData>('/overview', revision);
  const metrics = [['offices', 'Escritórios'], ['blocked_offices', 'Escritórios suspensos'], ['collaborators', 'Colaboradores ativos'], ['active_contracts', 'Contratos vigentes'], ['queued_jobs', 'Tarefas na fila'], ['failed_jobs', 'Tarefas com falha']] as const;
  return <DataState error={error} loading={!data}>{data && <HealthAlerts data={data} />}
    <div className="vf-platform-metrics">{metrics.map(([key, label]) => <Card key={key}><span className="vf-muted">{label}</span><strong>{data?.[key] ?? 0}</strong></Card>)}</div>
    <Card title="A plataforma em um só lugar"><p>Gerencie os escritórios e os contratos de acesso. O proprietário configura as conexões de IA e as contas da equipe do sistema.</p>
      <p className="vf-muted">O painel do contador continua dedicado aos clientes, declarações e à rotina do escritório.</p></Card>
  </DataState>;
}
function OfficesPage(p: PageProps) {
  const [edit, setEdit] = useState<Office | null>(null); const [search, setSearch] = useState(''); const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<string | null>(null); const today = todayIso();
  const debounced = useDebounced(search);
  const { data, error } = useData<Office[]>(`/offices?offset=${page * 100}&search=${encodeURIComponent(debounced)}`, p.revision);
  // a busca fica fora do DataState: se a consulta falhar, o campo continua editável para corrigir
  return <>
    <Input label="Buscar escritório" placeholder="Nome, e-mail ou CNPJ" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} />
    {detail && <OfficeDetailCard id={detail} p={p} onClose={() => setDetail(null)} />}
    <DataState error={error} loading={!data}>
    {edit && <Card title="Dados do escritório"><form className="vf-stack" onSubmit={(e) => { e.preventDefault(); void p.action(async () => {
      await request('/offices/' + edit.id, 'PUT', { name: edit.name, email: edit.email || null, city: edit.city || null, state: edit.state || null }); setEdit(null);
    }); }}><div className="vf-platform-form-grid">
      <Input label="Nome" required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
      <Input label="E-mail" type="email" value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} />
      <Input label="Cidade" value={edit.city ?? ''} onChange={(e) => setEdit({ ...edit, city: e.target.value })} />
      <Input label="UF" maxLength={2} value={edit.state ?? ''} onChange={(e) => setEdit({ ...edit, state: e.target.value.toUpperCase() })} />
    </div><div className="vf-inline"><Button type="submit" loading={p.busy}>Salvar escritório</Button><Button kind="tertiary" onClick={() => setEdit(null)}>Cancelar</Button></div></form></Card>}
    <div className="vf-platform-list">{data?.map((o) => <Card key={o.id}>
      <div className="vf-platform-row"><div><h2>{o.name}</h2><p className="vf-muted">{o.email ?? 'Sem e-mail'} · {[o.city, o.state].filter(Boolean).join(' / ') || 'Localidade não informada'}</p></div>
        <div className="vf-inline"><Button kind="secondary" onClick={() => { setDetail(o.id); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Ver ficha</Button>
          {p.owner && <Button kind="tertiary" onClick={() => setEdit(o)}>Editar</Button>}</div></div>
      <div className="vf-inline">{o.blockedAt && <Tag tone="danger">Acesso suspenso</Tag>}
        {!o.contractExpiresAt ? <Tag>Sem contrato</Tag> : o.contractExpiresAt < today ? <Tag tone="warning">Plano vencido em {o.contractExpiresAt.split('-').reverse().join('/')}</Tag> : <Tag tone="success">Plano até {o.contractExpiresAt.split('-').reverse().join('/')}</Tag>}
        <Tag>{o.customers} clientes</Tag><Tag>{o.collaborators} colaboradores</Tag>
        <span className="vf-muted">Último acesso: {o.lastLoginAt ? formatDateTimeBr(o.lastLoginAt) : 'nunca'}</span></div>
    </Card>)}</div>
    <div className="vf-inline"><Button kind="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</Button><span>Página {page + 1}</span>
      <Button kind="secondary" disabled={(data?.length ?? 0) < 100} onClick={() => setPage(page + 1)}>Próxima</Button></div>
  </DataState></>;
}
function AiPage(p: PageProps) {
  const { data, error } = useData<AiData>('/ai', p.revision);
  const [form, setForm] = useState<{ id?: string; provider: AiProviderKey; name: string; model: string; baseUrl: string; apiKey: string; supportsImages: boolean; enabled: boolean } | null>(null);
  const choose = (key: AiProviderKey) => { const def = aiProviderDef(key)!; setForm({ provider: key, name: def.label, model: '', baseUrl: def.baseUrl, apiKey: '', supportsImages: def.pdf, enabled: true }); };
  return <DataState error={error} loading={!data}>
    <div className="vf-platform-ai-banner"><Sparkles size={32} /><div><h2>Uma plataforma. Muitas possibilidades.</h2><p>13 opções de conexão e quantos modelos você precisar. As chaves ficam sob gestão do proprietário.</p></div></div>
    <Card title="Conexão usada pelos escritórios"><Select label="IA padrão" value={data?.defaultAiId ?? ''} disabled={p.busy} onChange={(e) => void p.action(() => request('/ai-default', 'PUT', { id: e.target.value || null }))}
      options={[{ value: '', label: data?.environmentConfigured ? 'Claude configurado no servidor' : 'Nenhuma conexão selecionada' }, ...(data?.connections.filter((c) => c.enabled || c.id === data.defaultAiId).map((c) => ({ value: c.id, label: `${c.name} · ${c.model}${c.enabled ? '' : ' · desativada'}` })) ?? [])]} />
      <p className="vf-muted">A escolha vale para os assistentes e a leitura de documentos. PDFs exigem Claude, OpenAI ou Gemini com um modelo que aceite esse formato.</p></Card>
    {form && <Card title={form.id ? 'Editar conexão' : 'Nova conexão'}><form className="vf-stack" onSubmit={(e) => { e.preventDefault(); void p.action(async () => {
      const { id, ...body } = form; await request(id ? '/ai/' + id : '/ai', id ? 'PUT' : 'POST', body); setForm(null);
    }, 'Conexão salva. Você pode testar a resposta e escolher a IA padrão.'); }}>
      <Tag tone="primary">{aiProviderDef(form.provider)?.label}</Tag>
      <div className="vf-platform-form-grid"><Input label="Nome da conexão" autoFocus required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Input label="Identificador do modelo" required placeholder="Copie o nome do modelo no serviço de IA" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
        {form.provider === 'compatible' && <Input label="Endereço da API" type="url" required placeholder="https://servico.com/v1" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />}
        {form.provider !== 'ollama' && <Input label="Chave de API" type="password" autoComplete="new-password" required={!form.id && form.enabled}
          placeholder={form.id ? 'Deixe vazio para manter a chave salva' : 'Cole a chave do serviço'} value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />}
      </div>
      {form.provider === 'ollama' && <Alert tone="primary" title="Modelo local no servidor">Ollama deve estar instalado no servidor do Verifco, disponível na porta 11434, com o modelo já baixado.</Alert>}
      <Checkbox label="Este modelo aceita imagens" checked={form.supportsImages} onChange={(e) => setForm({ ...form, supportsImages: e.target.checked })} />
      <Checkbox label="Conexão ativa" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
      <div className="vf-inline"><Button type="submit" loading={p.busy}>Salvar conexão</Button><Button kind="tertiary" onClick={() => setForm(null)}>Cancelar</Button></div>
    </form></Card>}
    <div className="vf-platform-section-title"><h2>Suas conexões</h2><Tag tone="primary">{data?.connections.length ?? 0} cadastradas</Tag></div>
    {!data?.connections.length && <Card><div className="vf-platform-empty"><PlugZap size={32} /><h3>Conecte sua primeira IA</h3><p>Escolha um serviço abaixo para configurar uma conexão.</p></div></Card>}
    <div className="vf-platform-connections">{data?.connections.map((c) => <Card key={c.id}>
      <div className="vf-platform-row"><Tag tone={c.enabled ? 'success' : 'neutral'}>{c.enabled ? 'Ativa' : 'Desativada'}</Tag>{c.id === data.defaultAiId && <Tag tone="primary"><Check size={12} /> Padrão</Tag>}</div>
      <h3>{c.name}</h3><p className="vf-muted">{aiProviderDef(c.provider)?.label}</p><code>{c.model}</code>
      <div className="vf-inline"><Tag>{c.pdf ? 'PDF' : 'Texto'}{c.supportsImages ? ' + imagens' : ''}</Tag><Tag>{c.status === 'connected' ? 'Teste confirmado' : c.status === 'error' ? 'Revisar conexão' : 'Ainda não testada'}</Tag></div>
      <p className="vf-muted">{c.provider === 'ollama' ? 'Modelo local' : c.keyConfigured ? 'Chave protegida no servidor' : 'Chave não configurada'}</p>
      <div className="vf-inline"><Button kind="secondary" onClick={() => setForm({ ...c, apiKey: '' })}>Editar</Button>
        <Button kind="tertiary" disabled={p.busy} onClick={() => p.confirm('Testar resposta da IA? Este teste pode consumir créditos do serviço.', async () => {
          const result = await request<{ ok: boolean; message: string }>('/ai/' + c.id + '/test', 'POST', {}); if (!result.ok) throw new ApiError(400, result.message); return result;
        }, 'O modelo respondeu. Conexão confirmada.')}>Testar resposta</Button>
        <Button kind="tertiary" disabled={p.busy || c.id === data.defaultAiId} onClick={() => p.confirm('Excluir esta conexão de IA?', () => request('/ai/' + c.id, 'DELETE'))}>Excluir</Button></div>
    </Card>)}</div>
    <div className="vf-platform-section-title"><h2>Adicionar uma conexão</h2><span className="vf-muted">Vários modelos do mesmo serviço também podem ser cadastrados.</span></div>
    <div className="vf-platform-provider-grid">{AI_PROVIDERS.map((def) => <button className="vf-platform-provider" type="button" key={def.key} onClick={() => choose(def.key)}>
      <span className="vf-platform-provider__symbol"><Sparkles size={21} /></span><strong>{def.label}</strong><span>{def.pdf ? 'Texto, imagens e PDF' : def.key === 'ollama' ? 'Modelos no seu servidor' : def.key === 'compatible' ? 'Amplie com outra API' : 'Modelos de texto e visão'}</span><Plus size={18} />
    </button>)}</div>
  </DataState>;
}
const CONTRACT_TAG = { cancelled: ['neutral', 'Cancelado'], expired: ['neutral', 'Expirado'], upcoming: ['primary', 'A iniciar'], active: ['success', 'Ativo'] } as const;

function ContractTag({ contract }: { contract: { status: string; startsAt: string; expiresAt: string } }) {
  const [tone, label] = CONTRACT_TAG[contractSituation(contract, todayIso())];
  return <Tag tone={tone}>{label}</Tag>;
}

function ContractsPage(p: PageProps) {
  const [page, setPage] = useState(0); const [officeSearch, setOfficeSearch] = useState(''); const [filter, setFilter] = useState('');
  const list = useData<Contract[]>(`/contracts?offset=${page * 100}${filter ? '&officeId=' + filter : ''}`, p.revision);
  const offices = useData<Office[]>(`/offices?limit=500&search=${encodeURIComponent(officeSearch)}`, p.revision);
  const [form, setForm] = useState<Contract | null>(null);
  const newContract = () => setForm({ id: '', officeId: offices.data?.[0]?.id ?? '', name: 'Acesso ao Verifco', plan: 'basic', declarationLimit: 100, year: Number(todayIso().slice(0, 4)), startsAt: todayIso(), expiresAt: '', hasBackup: false, status: 'active' });
  return <DataState error={list.error || offices.error} loading={!list.data || !offices.data}>
    <div className="vf-platform-row"><Select aria-label="Filtrar por escritório" value={filter} options={[{ value: '', label: 'Todos os escritórios' }, ...(offices.data?.map((o) => ({ value: o.id, label: o.name })) ?? [])]}
      onChange={(e) => { setFilter(e.target.value); setPage(0); }} />
      {p.owner && <Button icon={<Plus size={16} />} onClick={newContract}>Novo contrato</Button>}</div>
    {!list.data?.length && <Card><p className="vf-muted">Nenhum contrato{filter ? ' para este escritório' : ''}.</p></Card>}
    {form && <Card title={form.id ? 'Editar contrato' : 'Novo contrato'}><form className="vf-stack" onSubmit={(e) => { e.preventDefault(); void p.action(async () => {
      const { id, officeName: _officeName, ...body } = form; await request(id ? '/contracts/' + id : '/contracts', id ? 'PUT' : 'POST', body); setForm(null);
    }); }}><Input label="Localizar escritório pelo nome" value={officeSearch} onChange={(e) => setOfficeSearch(e.target.value)} /><div className="vf-platform-form-grid">
      <Select label="Escritório" required value={form.officeId} options={[
        { value: '', label: 'Selecione um escritório' },
        ...(form.officeId && !offices.data?.some((o) => o.id === form.officeId) ? [{ value: form.officeId, label: form.officeName ?? 'Escritório selecionado' }] : []),
        ...(offices.data?.map((o) => ({ value: o.id, label: o.name })) ?? []),
      ]} onChange={(e) => setForm({ ...form, officeId: e.target.value })} />
      <Input label="Nome do contrato" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <Input label="Plano" required list="vf-platform-plans" help="Nome livre: aparece para o escritório em Meu escritório › Contratos." value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })} />
      <datalist id="vf-platform-plans">{['trial', 'basic', 'profissional', 'ilimitado'].map((v) => <option key={v} value={v} />)}</datalist>
      <Input label="Exercício" type="number" min={2000} max={2100} required value={form.year} onChange={(e) => setForm({ ...form, year: Number(e.target.value) })} />
      <Input label="Início" type="date" required value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
      <Input label="Término" type="date" required min={form.startsAt} value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
      <Input label="Limite de declarações (vazio = ilimitado)" type="number" min={1} value={form.declarationLimit ?? ''} onChange={(e) => setForm({ ...form, declarationLimit: e.target.value ? Number(e.target.value) : null })} />
      <Select label="Situação" value={form.status} options={Object.entries(CONTRACT_STATUS).map(([value, label]) => ({ value, label }))} onChange={(e) => setForm({ ...form, status: e.target.value })} />
    </div><Checkbox label="Inclui cópia de segurança" checked={form.hasBackup} onChange={(e) => setForm({ ...form, hasBackup: e.target.checked })} />
      <div className="vf-inline"><Button type="submit" loading={p.busy}>Salvar contrato</Button><Button kind="tertiary" onClick={() => setForm(null)}>Cancelar</Button></div>
    </form></Card>}
    <div className="vf-platform-list">{list.data?.map((c) => <Card key={c.id}><div className="vf-platform-row"><div><h2>{c.officeName}</h2><p>{c.name} · {c.plan} · {c.year}</p></div>
      {p.owner && <Button kind="secondary" onClick={() => setForm(c)}>Editar contrato</Button>}</div><div className="vf-inline"><ContractTag contract={c} />
      <Tag>{c.declarationLimit === null ? 'Declarações ilimitadas' : c.declarationLimit + ' declarações'}</Tag><span className="vf-muted">{c.startsAt.split('-').reverse().join('/')} até {c.expiresAt.split('-').reverse().join('/')}</span></div></Card>)}</div>
    <div className="vf-inline"><Button kind="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</Button><span>Página {page + 1}</span>
      <Button kind="secondary" disabled={(list.data?.length ?? 0) < 100} onClick={() => setPage(page + 1)}>Próxima</Button></div>
  </DataState>;
}
function TeamPage(p: PageProps & { me: Account }) {
  const { data, error } = useData<Account[]>('/users', p.revision);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'developer' }); const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string; role: string } | null>(null); const [reset, setReset] = useState<{ id: string; name: string; password: string } | null>(null);
  const ROLES = [{ value: 'developer', label: 'Desenvolvedor — acompanha a operação' }, { value: 'owner', label: 'Proprietário — administra a plataforma' }];
  return <DataState error={error} loading={!data}><Button icon={<Plus size={16} />} onClick={() => setOpen(true)}>Adicionar à equipe</Button>
    {editing && <Card title="Editar conta do sistema"><form className="vf-stack" onSubmit={(e) => { e.preventDefault(); void p.action(async () => {
      await request('/users/' + editing.id, 'PUT', { name: editing.name, role: editing.role }); setEditing(null);
    }, 'Conta atualizada.'); }}><div className="vf-platform-form-grid"><Input label="Nome" required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
      <Select label="Perfil" disabled={editing.id === p.me.id} help={editing.id === p.me.id ? 'Você não pode mudar o seu próprio perfil.' : 'Ao mudar o perfil, as sessões abertas da conta são encerradas.'} value={editing.role} options={ROLES} onChange={(e) => setEditing({ ...editing, role: e.target.value })} />
    </div><div className="vf-inline"><Button type="submit" loading={p.busy}>Salvar</Button><Button kind="tertiary" onClick={() => setEditing(null)}>Cancelar</Button></div></form></Card>}
    {reset && <Card title={`Redefinir a senha de ${reset.name}`}><form className="vf-stack" onSubmit={(e) => { e.preventDefault(); void p.action(async () => {
      await request('/users/' + reset.id + '/password', 'PUT', { password: reset.password }); setReset(null);
    }, 'Senha redefinida. As sessões abertas da conta foram encerradas.'); }}>
      <Input label="Senha nova" type="password" autoComplete="new-password" minLength={12} required help="Pelo menos 12 caracteres. Entregue a senha por um canal seguro e peça para a pessoa trocar em Minha conta." value={reset.password} onChange={(e) => setReset({ ...reset, password: e.target.value })} />
      <div className="vf-inline"><Button type="submit" loading={p.busy} disabled={reset.password.length < 12}>Redefinir senha</Button><Button kind="tertiary" onClick={() => setReset(null)}>Cancelar</Button></div></form></Card>}
    {open && <Card title="Nova conta do sistema"><form className="vf-stack" onSubmit={(e) => { e.preventDefault(); void p.action(async () => {
      await request('/users', 'POST', form); setOpen(false); setForm({ name: '', email: '', password: '', role: 'developer' });
    }); }}><div className="vf-platform-form-grid"><Input label="Nome" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <Input label="E-mail" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      <Input label="Senha inicial" type="password" autoComplete="new-password" minLength={12} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
      <Select label="Perfil" value={form.role} options={ROLES} onChange={(e) => setForm({ ...form, role: e.target.value })} />
    </div><div className="vf-inline"><Button type="submit" loading={p.busy}>Criar conta</Button><Button kind="tertiary" onClick={() => setOpen(false)}>Cancelar</Button></div></form></Card>}
    <div className="vf-platform-list">{data?.map((user) => <Card key={user.id}><div className="vf-platform-row"><div><h2>{user.name}</h2><p className="vf-muted">{user.email} · último acesso: {user.lastLoginAt ? formatDateTimeBr(user.lastLoginAt) : 'nunca'}</p></div><div className="vf-inline">
      <Tag>{user.role === 'owner' ? 'Proprietário' : 'Desenvolvedor'}</Tag><Tag tone={user.isActive ? 'success' : 'neutral'}>{user.isActive ? 'Ativa' : 'Desativada'}</Tag>
      <Button kind="tertiary" disabled={p.busy} onClick={() => { setReset(null); setEditing({ id: user.id, name: user.name, role: user.role }); }}>Editar</Button>
      {user.id !== p.me.id && <Button kind="tertiary" disabled={p.busy} onClick={() => { setEditing(null); setReset({ id: user.id, name: user.name, password: '' }); }}>Redefinir senha</Button>}
      {user.id !== p.me.id && <Button kind="secondary" disabled={p.busy} onClick={() => p.confirm(user.isActive ? 'Desativar esta conta do sistema?' : 'Reativar esta conta do sistema?', () => request('/users/' + user.id + '/active', 'PUT', { isActive: !user.isActive }))}>{user.isActive ? 'Desativar' : 'Reativar'}</Button>}
    </div></div></Card>)}</div>
  </DataState>;
}
function AuditPage({ revision }: { revision: number }) {
  const { data, error } = useData<{ id: string; actor: string; action: string; createdAt: string }[]>('/audit', revision);
  const labels: Record<string, string> = { 'platform.login': 'Entrou no sistema', 'platform.logout': 'Saiu do sistema', 'platform.bootstrap': 'Criou a administração', 'office.update': 'Alterou escritório', 'contract.create': 'Criou contrato', 'contract.update': 'Alterou contrato', 'ai.create': 'Criou conexão de IA', 'ai.update': 'Alterou conexão de IA', 'ai.default': 'Escolheu a IA padrão', 'ai.test': 'Testou conexão de IA', 'ai.delete': 'Excluiu conexão de IA', 'platform.user.create': 'Criou conta do sistema', 'platform.user.active': 'Alterou acesso de conta',
    'platform.user.update': 'Alterou nome ou perfil de conta', 'platform.user.password': 'Redefiniu a senha de outra conta', 'platform.password.change': 'Trocou a própria senha', 'platform.password.cli': 'Senha redefinida pelo servidor',
    'office.block': 'Suspendeu o acesso de um escritório', 'office.unblock': 'Liberou o acesso de um escritório', 'job.retry': 'Recolocou uma tarefa na fila', 'job.dismiss': 'Dispensou tarefas com falha',
    'settings.update': 'Alterou as configurações do sistema', 'email.test': 'Testou o e-mail do sistema',
    'platform.2fa.enable': 'Ativou a verificação em duas etapas', 'platform.2fa.disable': 'Desativou a verificação em duas etapas',
    'office.user.reset_2fa': 'Desligou as duas etapas de uma conta de escritório', 'office.delete': 'Excluiu um escritório em definitivo' };
  return <DataState error={error} loading={!data}><Card title="Últimas 200 ações"><div className="vf-platform-audit">{data?.map((item) => <div key={item.id}><History size={17} /><div><strong>{labels[item.action] ?? item.action}</strong><p className="vf-muted">{item.actor} · {formatDateTimeBr(item.createdAt)}</p></div></div>)}</div></Card></DataState>;
}
