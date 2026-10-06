import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { CheckCircle2, Lock, Mail } from 'lucide-react';
import { Alert, Button, Input } from '../../ds';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';

function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page">
      <aside className="auth-page__aside">
        <img src="/verifco-logo-negativo.svg" alt="Verifco" style={{ height: 36, alignSelf: 'flex-start', position: 'relative', zIndex: 1 }} />
        <div>
          <h1>A temporada de IR organizada, do orçamento ao kit pós-declaração.</h1>
          <p>Clientes, documentos, procurações, cobranças e relatórios do Imposto de Renda num só lugar.</p>
          <ul>
            <li><CheckCircle2 /> Checklist digital para o cliente enviar documentos</li>
            <li><CheckCircle2 /> Kanban com o status de cada declaração</li>
            <li><CheckCircle2 /> Orçamentos, cobrança e recibos integrados</li>
            <li><CheckCircle2 /> Análises de caixa, patrimônio, IRPFM e holding</li>
          </ul>
        </div>
        <small style={{ color: '#7f93c9', position: 'relative', zIndex: 1 }}>© {new Date().getFullYear()} Verifco</small>
      </aside>
      <main className="auth-page__main">
        <div className="auth-page__form">{children}</div>
      </main>
    </div>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível entrar.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout>
      <form className="vf-stack" style={{ '--gap': '20px' } as React.CSSProperties} onSubmit={submit}>
        <div>
          <h2 className="vf-text-xl">Entrar</h2>
          <p className="vf-muted" style={{ marginTop: 4 }}>Acesse a conta do seu escritório.</p>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <Input label="E-mail" type="email" autoComplete="email" required icon={<Mail />} value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input label="Senha" type="password" autoComplete="current-password" required icon={<Lock />} value={password} onChange={(e) => setPassword(e.target.value)} />
        <div className="vf-inline vf-between">
          <Link to="/esqueci-senha">Esqueci minha senha</Link>
        </div>
        <Button type="submit" block loading={loading}>Entrar</Button>
        <p className="vf-muted" style={{ textAlign: 'center' }}>
          Ainda não usa o Verifco? <Link to="/cadastro">Crie a conta do escritório</Link>
        </p>
      </form>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ officeName: '', officeDocument: '', name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await register({ ...form, officeDocument: form.officeDocument || undefined });
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível criar a conta.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout>
      <form className="vf-stack" onSubmit={submit}>
        <div>
          <h2 className="vf-text-xl">Criar conta do escritório</h2>
          <p className="vf-muted" style={{ marginTop: 4 }}>30 dias de avaliação, sem cartão de crédito.</p>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <Input label="Nome do escritório" required value={form.officeName} onChange={set('officeName')} />
        <Input label="CNPJ ou CPF do escritório" help="Opcional" value={form.officeDocument} onChange={set('officeDocument')} />
        <Input label="Seu nome" required autoComplete="name" value={form.name} onChange={set('name')} />
        <Input label="E-mail" type="email" required autoComplete="email" value={form.email} onChange={set('email')} />
        <Input label="Senha" type="password" required minLength={8} autoComplete="new-password" help="Mínimo de 8 caracteres" value={form.password} onChange={set('password')} />
        <Button type="submit" block loading={loading}>Criar conta</Button>
        <p className="vf-muted" style={{ textAlign: 'center' }}>
          Já tem conta? <Link to="/entrar">Entrar</Link>
        </p>
      </form>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AuthLayout>
      <form
        className="vf-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setLoading(true);
          setError(null);
          try {
            await api.post('/auth/forgot-password', { email });
            setSent(true);
          } catch (err) {
            // a resposta é a mesma exista ou não a conta; só o limite de tentativas e a falta de conexão aparecem
            if (err instanceof ApiError && (err.status === 429 || err.status === 0 || err.status === 400)) setError(err.message);
            else setSent(true);
          } finally {
            setLoading(false);
          }
        }}
      >
        <h2 className="vf-text-xl">Esqueci minha senha</h2>
        {error && <Alert tone="danger">{error}</Alert>}
        {sent ? (
          <Alert tone="success">Se houver uma conta com este e-mail, você vai receber um link para criar uma nova senha.</Alert>
        ) : (
          <>
            <p className="vf-muted">Informe seu e-mail e enviaremos um link para redefinir a senha.</p>
            <Input label="E-mail" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <Button type="submit" block loading={loading}>Enviar link</Button>
          </>
        )}
        <Link to="/entrar">Voltar para o login</Link>
      </form>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const invite = params.get('convite') === '1';
  const token = params.get('token');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // sem o token do e-mail não há o que redefinir: explica e leva para pedir um link novo
  if (!token) {
    return (
      <AuthLayout>
        <div className="vf-stack">
          <h2 className="vf-text-xl">Link inválido ou expirado</h2>
          <Alert tone="danger">Este endereço não tem o código de redefinição. Abra o link completo que chegou por e-mail ou peça um novo.</Alert>
          <Link to="/esqueci-senha">Pedir um novo link</Link>
          <Link to="/entrar">Voltar para o login</Link>
        </div>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout>
      <form
        className="vf-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (password !== confirm) return setError('As senhas não conferem.');
          setLoading(true);
          setError(null);
          try {
            await api.post('/auth/reset-password', { token, password });
            navigate('/entrar');
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Link inválido.');
          } finally {
            setLoading(false);
          }
        }}
      >
        <h2 className="vf-text-xl">{invite ? 'Defina sua senha' : 'Nova senha'}</h2>
        {error && <Alert tone="danger">{error}</Alert>}
        <Input label="Senha" type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Input label="Confirme a senha" type="password" required minLength={8} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <Button type="submit" block loading={loading}>Salvar senha</Button>
      </form>
    </AuthLayout>
  );
}
