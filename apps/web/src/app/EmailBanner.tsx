import { useState } from 'react';
import { MailWarning } from 'lucide-react';
import { Alert, Button, useToast } from '../ds';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * Aviso para quem ainda não confirmou o e-mail de acesso: é por ele que chegam a redefinição de
 * senha e os avisos de segurança, então um endereço digitado errado deixa a conta sem saída.
 */
export function EmailBanner() {
  const { me } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  if (!me || me.user.emailVerified !== false) return null;
  const resend = async () => {
    setBusy(true);
    try {
      await api.post('/auth/verify-email/resend');
      setSent(true);
      toast.success(`Link enviado para ${me.user.email}.`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert tone="warning" title="Confirme o seu e-mail">
      <span className="vf-inline">
        <MailWarning size={16} aria-hidden />
        <span>
          Enviamos um link para <strong>{me.user.email}</strong>. Sem a confirmação, você pode ficar sem como redefinir a senha. Endereço errado? Corrija em Minha conta.
        </span>
        <Button kind="secondary" size="sm" loading={busy} disabled={sent} onClick={() => void resend()}>
          {sent ? 'Link enviado' : 'Enviar de novo'}
        </Button>
      </span>
    </Alert>
  );
}
