import { useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ListChecks, LogOut } from 'lucide-react';
import { Alert, Button, Card, EmptyState, Input, Loading } from '../../ds';
import { ApiError, errorMessage } from '../../lib/api';
import { CustomerChecklist } from './CustomerChecklist';
import { checklistSession, customerClient, maskCpfInput, publicApi, type ChecklistSession } from './customerApi';
import { PublicFrame } from './PublicFrame';

/** `/checklist/:token`: o cliente entra com CPF + código e preenche o checklist. */
export function ChecklistLinkPage() {
  const { token = '' } = useParams();
  const info = useQuery({
    queryKey: ['checklist-link', token],
    queryFn: () => publicApi.post<{ officeName: string; exerciseYear: number }>('/portal/checklist-link', { token }),
    retry: false,
  });
  const [session, setSession] = useState<ChecklistSession | null>(() => checklistSession.get(token));
  const [expired, setExpired] = useState(false);

  const logout = (wasExpired = false) => {
    checklistSession.set(null);
    setSession(null);
    setExpired(wasExpired);
  };
  const client = useMemo(() => (session ? customerClient(session.token, () => logout(true)) : null), [session]);

  if (info.isLoading) {
    return (
      <PublicFrame subtitle="Checklist do Imposto de Renda">
        <Loading />
      </PublicFrame>
    );
  }
  if (info.error || !info.data) {
    const notFound = info.error instanceof ApiError && info.error.status === 404;
    return (
      <PublicFrame subtitle="Checklist do Imposto de Renda">
        <Card>
          <EmptyState
            icon={<ListChecks />}
            title={notFound ? 'Este link não vale mais' : 'Não foi possível abrir o checklist'}
            description={notFound ? 'O link vale 30 dias e o escritório pode ter enviado um mais novo. Procure a mensagem mais recente ou peça um novo link ao escritório.' : 'Verifique sua conexão e tente de novo.'}
          />
        </Card>
      </PublicFrame>
    );
  }
  const { officeName, exerciseYear } = info.data;
  return (
    <PublicFrame
      officeName={officeName}
      subtitle={`Checklist do Imposto de Renda ${exerciseYear}`}
      right={
        session && (
          <Button kind="tertiary" size="sm" icon={<LogOut />} onClick={() => logout()}>
            Sair
          </Button>
        )
      }
    >
      {session && client ? (
        <CustomerChecklist checklistId={session.checklistId} client={client} />
      ) : (
        <LinkLogin
          token={token}
          officeName={officeName}
          exerciseYear={exerciseYear}
          expired={expired}
          onLogged={(s) => {
            checklistSession.set(s);
            setExpired(false);
            setSession(s);
          }}
        />
      )}
    </PublicFrame>
  );
}

function LinkLogin({ token, officeName, exerciseYear, expired, onLogged }: { token: string; officeName: string; exerciseYear: number; expired: boolean; onLogged: (s: ChecklistSession) => void }) {
  const [cpf, setCpf] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const r = await publicApi.post<{ token: string; checklistId: string }>('/portal/checklist-login', { token, cpf, code });
      onLogged({ link: token, token: r.token, checklistId: r.checklistId });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? 'Este link não vale mais. Peça um novo ao escritório.' : errorMessage(err, 'Não foi possível entrar.'));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="ck-login">
      <Card>
        <form className="vf-stack" style={{ '--gap': '20px' } as CSSProperties} onSubmit={submit}>
          <div className="vf-stack" style={{ '--gap': '8px' } as CSSProperties}>
            <span className="ck-login__icon">
              <ListChecks />
            </span>
            <h1 className="vf-text-lg">Documentos do seu IR {exerciseYear}</h1>
            <p className="vf-muted">
              {officeName} preparou uma lista com os documentos da sua declaração. Para entrar, informe seu CPF e o código que você recebeu.
            </p>
          </div>
          {expired && <Alert tone="warning">Sua sessão terminou. Entre de novo para continuar; o que você já enviou está salvo.</Alert>}
          {error && <Alert tone="danger">{error}</Alert>}
          <Input label="CPF" required inputMode="numeric" autoComplete="username" placeholder="000.000.000-00" value={cpf} onChange={(e) => setCpf(maskCpfInput(e.target.value))} />
          <Input
            label="Código de acesso"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6 dígitos"
            className="ck-code-input"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D+/g, '').slice(0, 6))}
            help="Está na mensagem que o escritório enviou por e-mail ou WhatsApp."
          />
          <Button type="submit" block loading={loading} disabled={cpf.replace(/\D/g, '').length !== 11 || code.length !== 6}>
            Entrar
          </Button>
        </form>
      </Card>
    </div>
  );
}
