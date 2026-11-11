import { useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Copy, ShieldCheck, ShieldOff } from 'lucide-react';
import { Alert, Button, Card, Input, Modal, PasswordInput, Tag, useToast } from '../ds';
import { errorMessage } from '../lib/api';

/** QR code em SVG (o conteúdo é o endereço `otpauth://` devolvido pela API). */
export function QrCode({ value, size = 184 }: { value: string; size?: number }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    const dark: [number, number][] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) dark.push([r, c]);
    return { n, dark };
  }, [value]);
  const margin = 4;
  const total = cells.n + margin * 2;
  return (
    <svg role="img" aria-label="QR code para o aplicativo autenticador" width={size} height={size} viewBox={`0 0 ${total} ${total}`} shapeRendering="crispEdges" style={{ background: '#fff', borderRadius: 8 }}>
      <rect width={total} height={total} fill="#fff" />
      {cells.dark.map(([r, c]) => (
        <rect key={`${r}-${c}`} x={c + margin} y={r + margin} width={1} height={1} fill="#000" />
      ))}
    </svg>
  );
}

type Post = <T>(path: string, body: unknown) => Promise<T>;

/**
 * Verificação em duas etapas da conta de quem está logado. Serve ao painel do escritório e ao
 * do sistema: `post` chama `/2fa/setup`, `/2fa/enable` e `/2fa/disable` do painel em uso.
 */
export function TwoFactorCard({ enabled, post, onChange }: { enabled: boolean; post: Post; onChange: () => void }) {
  const toast = useToast();
  const [step, setStep] = useState<'idle' | 'password' | 'scan' | 'codes' | 'disable'>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [recovery, setRecovery] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const close = () => {
    setStep('idle');
    setPassword('');
    setCode('');
    setSetup(null);
    setRecovery([]);
    setError('');
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const start = () =>
    run(async () => {
      setSetup(await post<{ secret: string; otpauthUrl: string }>('/2fa/setup', { password }));
      setPassword('');
      setStep('scan');
    });
  const enable = () =>
    run(async () => {
      const r = await post<{ recoveryCodes: string[] }>('/2fa/enable', { code });
      setRecovery(r.recoveryCodes);
      setCode('');
      setStep('codes');
      onChange();
    });
  const disable = () =>
    run(async () => {
      await post('/2fa/disable', { password, code });
      toast.success('Verificação em duas etapas desativada.');
      close();
      onChange();
    });
  const copy = (text: string, done: string) =>
    void navigator.clipboard.writeText(text).then(
      () => toast.success(done),
      () => toast.error('Não foi possível copiar. Selecione o texto e copie manualmente.'),
    );
  const grouped = (setup?.secret ?? '').replace(/(.{4})/g, '$1 ').trim();

  return (
    <Card title="Verificação em duas etapas" actions={enabled ? <Tag tone="success" icon={<ShieldCheck size={14} />}>Ativa</Tag> : <Tag icon={<ShieldOff size={14} />}>Desativada</Tag>}>
      <div className="vf-stack">
        <span className="vf-muted">
          Além da senha, o login pede um código de 6 dígitos gerado por um aplicativo autenticador no seu celular (Google Authenticator, Microsoft Authenticator, Authy ou o seu gerenciador de senhas). Quem descobrir a sua senha não entra sem o
          celular.
        </span>
        <div className="vf-inline vf-end">
          {enabled ? (
            <Button kind="secondary" onClick={() => setStep('disable')}>
              Desativar
            </Button>
          ) : (
            <Button icon={<ShieldCheck />} onClick={() => setStep('password')}>
              Ativar
            </Button>
          )}
        </div>
      </div>

      <Modal
        open={step === 'password'}
        title="Ativar a verificação em duas etapas"
        onClose={close}
        width={480}
        footer={
          <>
            <Button kind="secondary" onClick={close}>
              Cancelar
            </Button>
            <Button loading={busy} disabled={!password} onClick={() => void start()}>
              Continuar
            </Button>
          </>
        }
      >
        <form
          className="vf-stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (password) void start();
          }}
        >
          {error && <Alert tone="danger">{error}</Alert>}
          <PasswordInput label="Confirme a sua senha atual" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </form>
      </Modal>

      <Modal
        open={step === 'scan'}
        title="Leia o QR code no aplicativo"
        onClose={close}
        width={520}
        footer={
          <>
            <Button kind="secondary" onClick={close}>
              Cancelar
            </Button>
            <Button loading={busy} disabled={code.replace(/\D/g, '').length !== 6} onClick={() => void enable()}>
              Ativar
            </Button>
          </>
        }
      >
        {setup && (
          <form
            className="vf-stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.replace(/\D/g, '').length === 6) void enable();
            }}
          >
            {error && <Alert tone="danger">{error}</Alert>}
            <span>1. No aplicativo autenticador, escolha adicionar uma conta e aponte a câmera para o código abaixo.</span>
            <div className="vf-inline" style={{ justifyContent: 'center' }}>
              <QrCode value={setup.otpauthUrl} />
            </div>
            <span className="vf-muted">
              Sem câmera? Digite esta chave no aplicativo: <span className="vf-mono">{grouped}</span>{' '}
              <Button kind="tertiary" size="sm" icon={<Copy />} onClick={() => copy(setup.secret, 'Chave copiada.')}>
                Copiar
              </Button>
            </span>
            <Input label="2. Digite o código de 6 dígitos que o aplicativo mostra" inputMode="numeric" autoComplete="one-time-code" maxLength={7} autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
          </form>
        )}
      </Modal>

      <Modal open={step === 'codes'} title="Guarde os códigos de recuperação" onClose={close} width={520} footer={<Button onClick={close}>Já guardei</Button>}>
        <div className="vf-stack">
          <Alert tone="warning" title="Eles aparecem só agora">
            Se você perder o celular, cada código abaixo entra no lugar do código do aplicativo, uma única vez. Guarde fora do celular (gerenciador de senhas, papel).
          </Alert>
          <pre className="vf-mono" style={{ margin: 0, columns: 2 }}>
            {recovery.join('\n')}
          </pre>
          <div className="vf-inline">
            <Button kind="secondary" icon={<Copy />} onClick={() => copy(recovery.join('\n'), 'Códigos copiados.')}>
              Copiar códigos
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={step === 'disable'}
        title="Desativar a verificação em duas etapas"
        onClose={close}
        width={480}
        footer={
          <>
            <Button kind="secondary" onClick={close}>
              Cancelar
            </Button>
            <Button kind="danger" loading={busy} disabled={!password || code.trim().length < 6} onClick={() => void disable()}>
              Desativar
            </Button>
          </>
        }
      >
        <form
          className="vf-stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (password && code.trim().length >= 6) void disable();
          }}
        >
          {error && <Alert tone="danger">{error}</Alert>}
          <span className="vf-muted">Depois disso o login volta a pedir só a senha.</span>
          <PasswordInput label="Senha atual" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          <Input label="Código do aplicativo ou um código de recuperação" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
        </form>
      </Modal>
    </Card>
  );
}
