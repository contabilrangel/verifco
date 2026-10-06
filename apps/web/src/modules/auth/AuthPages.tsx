import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ArrowLeft, ChartLine, ClipboardCheck, KeyRound, Lock, Mail, MailCheck, ReceiptText, SquareKanban } from 'lucide-react';
import { Alert, Button, Input, PasswordInput } from '../../ds';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { AuthFooter, AuthHeading, AuthLayout as Frame, type AuthFeature } from '../../app/AuthLayout';

const FEATURES: AuthFeature[] = [
  { icon: <ClipboardCheck />, title: 'Checklist digital', text: 'O cliente envia os documentos por um link.' },
  { icon: <SquareKanban />, title: 'Kanban das declarações', text: 'O status de cada declaração à vista.' },
  { icon: <ReceiptText />, title: 'Orçamentos e cobrança', text: 'Propostas, cobranças e recibos integrados.' },
  { icon: <ChartLine />, title: 'Análises tributárias', text: 'Caixa, patrimônio, IRPFM e holding.' },
];

function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <Frame
      eyebrow="Gestão de IRPF para escritórios contábeis"
      title={<>A temporada de IR organizada, <span className="auth-page__accent">do orçamento ao kit pós-declaração.</span></>}
      lead="Clientes, documentos, procurações, cobranças e relatórios do Imposto de Renda num só lugar."
      features={FEATURES}
    >
      {children}
    </Frame>
  );
}

const BackToLogin = () => (
  <Link to="/entrar" className="auth-page__back"><ArrowLeft aria-hidden /> Voltar para o login</Link>
);

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
      <form className="auth-page__form" onSubmit={submit}>
        <AuthHeading title="Entrar" subtitle="Acesse a conta do seu escritório." />
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="auth-page__fields">
          <Input label="E-mail" type="email" autoComplete="email" required icon={<Mail />} value={email} onChange={(e) => setEmail(e.target.value)} />
          <div className="auth-page__password">
            <PasswordInput label="Senha" autoComplete="current-password" required icon={<Lock />} value={password} onChange={(e) => setPassword(e.target.value)} />
            <Link to="/esqueci-senha" className="auth-page__forgot">Esqueci minha senha</Link>
          </div>
        </div>
        <Button type="submit" block loading={loading}>Entrar</Button>
        <AuthFooter>
          <span>Ainda não usa o Verifco? <Link to="/cadastro">Crie a conta do escritório</Link></span>
        </AuthFooter>
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
      <form className="auth-page__form" onSubmit={submit}>
        <AuthHeading title="Criar conta do escritório" subtitle="30 dias de avaliação, sem cartão de crédito." />
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="auth-page__fields">
          <Input label="Nome do escritório" required autoComplete="organization" value={form.officeName} onChange={set('officeName')} />
          <Input label="CNPJ ou CPF do escritório" help="Opcional" value={form.officeDocument} onChange={set('officeDocument')} />
          <Input label="Seu nome" required autoComplete="name" value={form.name} onChange={set('name')} />
          <Input label="E-mail" type="email" required autoComplete="email" value={form.email} onChange={set('email')} />
          <PasswordInput label="Senha" required minLength={8} autoComplete="new-password" help="Mínimo de 8 caracteres" value={form.password} onChange={set('password')} />
        </div>
        <Button type="submit" block loading={loading}>Criar conta</Button>
        <AuthFooter>
          <span>Já tem conta? <Link to="/entrar">Entrar</Link></span>
        </AuthFooter>
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
        className="auth-page__form"
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
        <AuthHeading
          icon={sent ? <MailCheck /> : <KeyRound />}
          title={sent ? 'Verifique seu e-mail' : 'Esqueci minha senha'}
          subtitle={sent ? undefined : 'Informe seu e-mail e enviaremos um link para criar uma nova senha.'}
        />
        {error && <Alert tone="danger">{error}</Alert>}
        {sent ? (
          <Alert tone="success">Se houver uma conta com este e-mail, você vai receber um link para criar uma nova senha.</Alert>
        ) : (
          <>
            <Input label="E-mail" type="email" autoComplete="email" required icon={<Mail />} value={email} onChange={(e) => setEmail(e.target.value)} />
            <Button type="submit" block loading={loading}>Enviar link</Button>
          </>
        )}
        <AuthFooter>
          <BackToLogin />
        </AuthFooter>
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
        <div className="auth-page__form">
          <AuthHeading icon={<KeyRound />} title="Link inválido ou expirado" />
          <Alert tone="danger">Este endereço não tem o código de redefinição. Abra o link completo que chegou por e-mail ou peça um novo.</Alert>
          <AuthFooter>
            <Link to="/esqueci-senha">Pedir um novo link</Link>
            <BackToLogin />
          </AuthFooter>
        </div>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout>
      <form
        className="auth-page__form"
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
        <AuthHeading
          icon={<KeyRound />}
          title={invite ? 'Defina sua senha' : 'Nova senha'}
          subtitle={invite ? 'Crie a senha de acesso à sua conta no Verifco.' : 'Escolha uma nova senha para a sua conta.'}
        />
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="auth-page__fields">
          <PasswordInput label="Senha" required minLength={8} autoComplete="new-password" help="Mínimo de 8 caracteres" value={password} onChange={(e) => setPassword(e.target.value)} />
          <PasswordInput label="Confirme a senha" required minLength={8} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <Button type="submit" block loading={loading}>Salvar senha</Button>
        <AuthFooter>
          <BackToLogin />
        </AuthFooter>
      </form>
    </AuthLayout>
  );
}
