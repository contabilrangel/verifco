import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { QrCode, RefreshCw } from 'lucide-react';
import { formatPhone } from '@verifco/shared';
import { QrCode as QrCodeSvg } from '../../app/TwoFactorCard';
import { Alert, Button, Spinner, Tag, useToast } from '../../ds';
import { api, errorMessage } from '../../lib/api';
import { useApi } from '../../lib/hooks';

/** Resposta de GET /integrations/whatsapp/connection e POST /integrations/whatsapp/connect. */
export interface WhatsAppConnectionView {
  state: 'open' | 'connecting' | 'close';
  number: string | null;
  profileName: string | null;
  qrImage: string | null;
  qrCode: string | null;
  pairingCode: string | null;
}

const KEY = ['integrations', 'whatsapp-connection'];
/** Consulta do estado enquanto o QR Code está na tela. */
const POLL_MS = 3000;
/** O WhatsApp troca o QR Code a cada poucos segundos: a tela busca o da vez. */
const QR_REFRESH_MS = 20_000;
/** Depois de tantas trocas sem leitura (uns dois minutos), a tela para e oferece gerar outro. */
const MAX_QR_REFRESHES = 6;

/** "+55 (11) 98765-4321" para número brasileiro; os demais, "+" e os dígitos. */
export function formatWhatsAppNumber(digits: string): string {
  const national = digits.startsWith('55') && (digits.length === 12 || digits.length === 13) ? digits.slice(2) : null;
  return national ? `+55 ${formatPhone(national)}` : `+${digits}`;
}

const QR_LABEL = 'QR Code para conectar o WhatsApp';
const QR_SIZE = 220;

/**
 * Bloco "Conectar" do WhatsApp pela Evolution API: mostra o estado da instância, pede o QR Code,
 * consulta o estado a cada poucos segundos até o celular ler o código e mostra o número conectado.
 * `ready`: a configuração salva tem URL, instância e API key (sem alterações pendentes).
 */
export function WhatsAppConnect({ ready, pollMs = POLL_MS, qrRefreshMs = QR_REFRESH_MS }: { ready: boolean; pollMs?: number; qrRefreshMs?: number }) {
  const toast = useToast();
  const qc = useQueryClient();
  /** O QR Code está na tela, esperando a leitura. */
  const [linking, setLinking] = useState(false);
  const [qr, setQr] = useState<WhatsAppConnectionView | null>(null);
  const [expired, setExpired] = useState(false);
  const refreshes = useRef(0);

  const status = useApi<WhatsAppConnectionView>(KEY, ready ? '/integrations/whatsapp/connection' : null, { refetchInterval: linking ? pollMs : false });
  const connect = useMutation<WhatsAppConnectionView, Error, { refresh: boolean }>({
    mutationFn: (body) => api.post<WhatsAppConnectionView>('/integrations/whatsapp/connect', body),
    onSuccess: (r) => {
      if (r.state === 'open') qc.setQueryData(KEY, r);
      // cópia: cada resposta agenda a próxima troca, mesmo trazendo o mesmo código
      else setQr({ ...r });
    },
    // o motivo fica no próprio bloco; sem conseguir o QR Code, não adianta seguir consultando
    onError: () => {
      setLinking(false);
      setQr(null);
    },
  });
  const requestQr = connect.mutate;

  const state = status.data?.state;
  const connected = state === 'open';
  // a imagem pronta da instância ou, sem ela, o conteúdo do código para desenhar aqui
  const hasQr = Boolean(qr?.qrImage || qr?.qrCode);

  // o celular leu o código: fecha o QR Code e avisa
  useEffect(() => {
    if (!linking || !connected) return;
    setLinking(false);
    setQr(null);
    toast.success('WhatsApp conectado.');
  }, [linking, connected, toast]);

  // troca do QR Code: logo em seguida se ele ainda não veio, senão no ritmo do WhatsApp
  useEffect(() => {
    if (!linking || connected || !qr) return;
    const timer = setTimeout(
      () => {
        if (refreshes.current >= MAX_QR_REFRESHES) {
          setLinking(false);
          setQr(null);
          setExpired(true);
          return;
        }
        refreshes.current += 1;
        requestQr({ refresh: true });
      },
      hasQr || qr.pairingCode ? qrRefreshMs : pollMs,
    );
    return () => clearTimeout(timer);
  }, [linking, connected, qr, hasQr, pollMs, qrRefreshMs, requestQr]);

  const start = () => {
    refreshes.current = 0;
    setExpired(false);
    setQr(null);
    setLinking(true);
    requestQr({ refresh: false });
  };

  const problem = connect.error ?? (status.error && !status.data ? status.error : null) ?? (linking ? status.error : null);

  return (
    <section className="vf-int-connect" aria-label="Conectar o WhatsApp">
      <div className="vf-int-connect-head">
        <div className="vf-stack" style={{ '--gap': '4px' } as CSSProperties}>
          <span className="vf-field__label">Conectar</span>
          {!ready ? (
            <span className="vf-field__help">Salve a URL, a instância e a API key para conectar o número do escritório por aqui.</span>
          ) : connected ? (
            <span className="vf-inline" style={{ '--gap': '8px' } as CSSProperties}>
              <Tag tone="success">Conectado</Tag>
              {status.data?.number ? (
                <span>
                  Conectado como <strong>{formatWhatsAppNumber(status.data.number)}</strong>
                  {status.data.profileName ? ` (${status.data.profileName})` : ''}
                </span>
              ) : (
                <span>A instância está conectada ao WhatsApp.</span>
              )}
            </span>
          ) : linking ? (
            <span className="vf-field__help">Aguardando a leitura do QR Code no celular do escritório…</span>
          ) : status.isLoading ? (
            <span className="vf-field__help">Consultando a instância…</span>
          ) : state ? (
            <span className="vf-inline" style={{ '--gap': '8px' } as CSSProperties}>
              <Tag tone={state === 'connecting' ? 'warning' : 'neutral'}>{state === 'connecting' ? 'Aguardando leitura' : 'Desconectado'}</Tag>
              <span className="vf-field__help">Leia o QR Code com o WhatsApp do escritório para conectar a instância.</span>
            </span>
          ) : (
            <span className="vf-field__help">Leia o QR Code com o WhatsApp do escritório para conectar a instância.</span>
          )}
        </div>
        {ready && !connected && !linking && (
          <Button kind="secondary" size="sm" icon={expired ? <RefreshCw /> : <QrCode />} loading={connect.isPending} onClick={start}>
            {expired ? 'Gerar outro QR Code' : 'Conectar'}
          </Button>
        )}
        {linking && (
          <Button
            kind="tertiary"
            size="sm"
            onClick={() => {
              setLinking(false);
              setQr(null);
            }}
          >
            Cancelar
          </Button>
        )}
      </div>

      {problem && <Alert tone="danger">{errorMessage(problem)}</Alert>}
      {expired && !linking && !connected && <Alert tone="warning">O QR Code não foi lido a tempo. Gere outro quando estiver com o celular em mãos.</Alert>}

      {linking && !connected && (
        <div className="vf-int-qr">
          {qr?.qrImage ? (
            <img src={qr.qrImage} alt={QR_LABEL} width={QR_SIZE} height={QR_SIZE} />
          ) : qr?.qrCode ? (
            <span className="vf-int-qr-drawn">
              <QrCodeSvg value={qr.qrCode} size={QR_SIZE} label={QR_LABEL} />
            </span>
          ) : !qr?.pairingCode ? (
            <span className="vf-inline vf-field__help" style={{ '--gap': '8px' } as CSSProperties}>
              <Spinner size={16} /> Gerando o QR Code…
            </span>
          ) : null}
          {(hasQr || qr?.pairingCode) && (
            <div className="vf-stack" style={{ '--gap': '6px' } as CSSProperties}>
              <ol className="vf-int-steps">
                <li>No celular do escritório, abra o WhatsApp.</li>
                <li>Toque em Dispositivos conectados › Conectar dispositivo.</li>
                <li>{hasQr ? 'Aponte a câmera para este código.' : 'Escolha conectar com número de telefone e digite o código abaixo.'}</li>
              </ol>
              {qr?.pairingCode && (
                <span className="vf-text-xs">
                  {hasQr ? 'Ou conecte com o número de telefone e o código ' : 'Código: '}
                  <code className="vf-int-pairing">{qr.pairingCode}</code>
                </span>
              )}
              <span className="vf-field__help">O código é trocado sozinho a cada poucos segundos; esta tela avisa quando conectar.</span>
            </div>
          )}
        </div>
      )}

      {ready && (
        <span className="vf-field__help">
          Para a situação dos envios (entregue, lido, falhou) chegar ao Verifco, marque também o evento MESSAGES_UPDATE no webhook da instância.
        </span>
      )}
    </section>
  );
}
