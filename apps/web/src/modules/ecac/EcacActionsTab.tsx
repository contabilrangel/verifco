import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { BadgeCheck, Building, Calculator, ExternalLink, FileSearch, Puzzle } from 'lucide-react';
import { ECAC_SERVICES, type EcacService } from '@verifco/shared';
import { Alert, Button, Card, Modal, Tag, useToast } from '../../ds';
import { useAuth } from '../../lib/auth';
import { useCustomer } from '../customers/customerContext';
import { openEcacService, pingExtension } from './extension';

const SERVICES: { id: EcacService; icon: ReactNode; description: string }[] = [
  { id: 'carne_leao', icon: <Calculator />, description: 'Lançamentos mensais de rendimentos recebidos de pessoas físicas e do exterior.' },
  { id: 'meu_irpf', icon: <FileSearch />, description: 'Situação da declaração, pendências, restituição e extrato da DIRPF.' },
  { id: 'cnd', icon: <BadgeCheck />, description: 'Certidão de débitos relativos a tributos federais e à dívida ativa da União.' },
  { id: 'fontes_pagadoras', icon: <Building />, description: 'Rendimentos informados por fontes pagadoras em nome do cliente.' },
];

export function EcacActionsTab() {
  const { customer } = useCustomer();
  const { can } = useAuth();
  const toast = useToast();
  const [ext, setExt] = useState<'checking' | 'missing' | { version?: string }>('checking');
  const [opening, setOpening] = useState<EcacService | null>(null);
  const [showInstall, setShowInstall] = useState(false);

  useEffect(() => {
    let alive = true;
    void pingExtension().then((ack) => alive && setExt(ack ? { version: ack.version } : 'missing'));
    return () => {
      alive = false;
    };
  }, []);

  const open = async (service: EcacService) => {
    setOpening(service);
    const ack = await openEcacService(service, customer.cpfCnpj);
    setOpening(null);
    if (!ack) {
      setExt('missing');
      setShowInstall(true);
      return;
    }
    setExt({ version: ack.version });
    if (ack.ok) toast.success(`Abrindo ${ECAC_SERVICES[service]} no eCAC em uma nova aba.`);
    else toast.error(ack.error ?? 'A extensão não conseguiu abrir o serviço.');
  };

  return (
    <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>
      <Card>
        <div className="vf-inline vf-between">
          <div className="vf-stack" style={{ '--gap': '4px' } as React.CSSProperties}>
            <h2 className="vf-text-lg">Bem-vindo ao Ações eCAC</h2>
            <span className="vf-muted">Você pode acessar os serviços do eCAC com a automação da extensão Verifco. O CPF do cliente é levado junto para facilitar a troca de perfil como procurador.</span>
          </div>
          {ext === 'checking' ? (
            <Tag>Procurando a extensão…</Tag>
          ) : ext === 'missing' ? (
            <Tag tone="warning" icon={<Puzzle size={14} />}>
              Extensão não detectada
            </Tag>
          ) : (
            <Tag tone="success" icon={<Puzzle size={14} />}>
              Extensão ativa{ext.version ? ` · v${ext.version}` : ''}
            </Tag>
          )}
        </div>
      </Card>
      <div className="vf-grid" style={{ '--cols': 4 } as React.CSSProperties}>
        {SERVICES.map((s) => (
          <Card key={s.id} className="vf-ecac-service">
            <div className="vf-ecac-service__icon">{s.icon}</div>
            <h3 className="vf-text-md-bold">{ECAC_SERVICES[s.id]}</h3>
            <p className="vf-muted vf-text-sm">{s.description}</p>
            <Button
              kind="secondary"
              icon={<ExternalLink />}
              disabled={!can('ecac.actions')}
              title={!can('ecac.actions') ? 'Seu perfil não tem a permissão "Ações eCAC pela extensão"' : undefined}
              loading={opening === s.id}
              onClick={() => void open(s.id)}
            >
              Acessar
            </Button>
          </Card>
        ))}
      </div>
      <Alert>
        A extensão abre o serviço numa aba do seu navegador, com o seu login gov.br. O Verifco não acessa o eCAC por você nem guarda a sessão.
      </Alert>
      <Modal
        open={showInstall}
        title="Instale a extensão Verifco"
        onClose={() => setShowInstall(false)}
        footer={
          <>
            <Button kind="secondary" onClick={() => setShowInstall(false)}>
              Fechar
            </Button>
            <Link to="/downloads" className="vf-btn">
              Ir para a Central de downloads
            </Link>
          </>
        }
      >
        <div className="vf-stack">
          <span>A extensão não respondeu nesta página. Para usar as Ações eCAC:</span>
          <ol className="vf-ecac-steps">
            <li>Abra a Central de downloads e siga as instruções da extensão para Chrome, Edge ou Opera.</li>
            <li>Na extensão, informe o endereço do Verifco e um token do tipo “Extensão” (Administração › Robô).</li>
            <li>Recarregue esta página e clique em “Acessar” de novo.</li>
          </ol>
        </div>
      </Modal>
    </div>
  );
}
