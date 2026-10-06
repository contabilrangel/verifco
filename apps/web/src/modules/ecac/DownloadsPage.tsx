import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Download, FolderSync, Globe, Laptop, Monitor, Puzzle, Terminal } from 'lucide-react';
import { Alert, Button, Card, Tabs, useToast } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { apiBaseUrl } from './ui';

type Os = 'windows' | 'macos' | 'linux';
type Browser = 'chrome' | 'edge' | 'opera' | 'safari';

const SYNC_FOLDER: Record<Os, string> = { windows: 'C:\\Verifco\\sincronizador', macos: '~/Verifco/sincronizador', linux: '~/verifco-sincronizador' };
const TERMINAL: Record<Os, string> = { windows: 'Prompt de Comando (ou PowerShell)', macos: 'Terminal', linux: 'terminal' };
const AUTOSTART: Record<Os, string> = {
  windows: 'Para iniciar junto com o Windows, crie uma tarefa no Agendador de Tarefas que rode “npm start” nessa pasta ao fazer logon.',
  macos: 'Para iniciar junto com o macOS, use um LaunchAgent (exemplo no README do sincronizador).',
  linux: 'Para iniciar junto com a sessão, use um serviço de usuário do systemd (exemplo no README do sincronizador).',
};
const EXT_PAGE: Record<Exclude<Browser, 'safari'>, string> = { chrome: 'chrome://extensions', edge: 'edge://extensions', opera: 'opera://extensions' };

export function DownloadsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [os, setOs] = useState<Os>(() => (/Mac/i.test(navigator.platform) ? 'macos' : /Linux/i.test(navigator.platform) ? 'linux' : 'windows'));
  const [browser, setBrowser] = useState<Browser>(() => (/Edg\//.test(navigator.userAgent) ? 'edge' : /OPR\//.test(navigator.userAgent) ? 'opera' : 'chrome'));
  const [busy, setBusy] = useState<string | null>(null);
  const base = apiBaseUrl();

  const download = async (pkg: 'sync' | 'extension') => {
    setBusy(pkg);
    try {
      await api.download(`/robot/downloads/${pkg}`, `verifco-${pkg === 'sync' ? 'sincronizador' : 'extensao'}.zip`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Falha no download.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Central de downloads"
        description="Programas que conectam o computador do escritório ao Verifco: o sincronizador de arquivos do programa IRPF e a extensão do navegador para o eCAC."
        crumbs={[{ label: 'Início', to: '/' }, { label: 'Central de downloads' }]}
      />
      <div className="vf-grid" style={{ '--cols': 2, alignItems: 'start' } as React.CSSProperties}>
        <Card title={<span className="vf-inline"><FolderSync size={20} /> Sincronizador Verifco</span>}>
          <div className="vf-stack">
            <span className="vf-muted">
              Roda no computador onde o programa IRPF é usado. Arquiva no Verifco os arquivos das declarações (.DEC, .REC, .DBK) e das pré-preenchidas, vinculando cada um ao cliente pelo CPF do nome do arquivo. O .REC marca a declaração como transmitida; o conteúdo dos arquivos do programa não é lido (leiaute não público).
            </span>
            <Tabs<Os>
              value={os}
              onChange={setOs}
              items={[
                { value: 'windows', label: 'Windows', icon: <Monitor size={16} /> },
                { value: 'macos', label: 'macOS', icon: <Laptop size={16} /> },
                { value: 'linux', label: 'Linux', icon: <Terminal size={16} /> },
              ]}
            />
            <ol className="vf-ecac-timeline">
              <Step n={1} title="Instale o Node.js 22 ou mais novo">
                Baixe em <a href="https://nodejs.org" target="_blank" rel="noreferrer">nodejs.org</a> (versão LTS).
              </Step>
              <Step n={2} title="Baixe e descompacte o sincronizador">
                <div className="vf-stack" style={{ '--gap': '8px' } as React.CSSProperties}>
                  <span>
                    Descompacte numa pasta fixa, por exemplo <span className="vf-mono">{SYNC_FOLDER[os]}</span>.
                  </span>
                  <div>
                    <Button size="sm" icon={<Download />} loading={busy === 'sync'} onClick={() => void download('sync')}>
                      Baixar sincronizador (.zip)
                    </Button>
                  </div>
                </div>
              </Step>
              <Step n={3} title="Instale as dependências">
                No {TERMINAL[os]}, dentro da pasta: <Code>npm install</Code>
              </Step>
              <Step n={4} title="Conecte ao Verifco">
                Crie um token do tipo “Sincronizador” em {can('ecac.robot') ? <Link to="/admin/robo">Administração › Robô</Link> : 'Administração › Robô'} e rode:
                <Code>{`npm run config -- --url ${base} --token vfk_...`}</Code>
                <Code>npm run testar</Code>
              </Step>
              <Step n={5} title="Confira as pastas observadas">
                <Code>npm run pastas</Code>
                Por padrão, observamos as pastas do programa IRPF do ano atual e do anterior que existirem neste computador. Para incluir outra: <Code>{`npm run config -- --pasta "${os === 'windows' ? 'D:\\Declaracoes' : '~/Declaracoes'}"`}</Code>
              </Step>
              <Step n={6} title="Inicie">
                <Code>npm start</Code>
                Faz uma varredura inicial e depois envia cada arquivo novo ou alterado. {AUTOSTART[os]}
              </Step>
            </ol>
          </div>
        </Card>

        <Card title={<span className="vf-inline"><Puzzle size={20} /> Extensão Verifco</span>}>
          <div className="vf-stack">
            <span className="vf-muted">
              Abre os serviços do eCAC a partir da aba “Ações eCAC” do cliente e, quando habilitado, envia ao Verifco os dados das páginas do eCAC que você visitar.
            </span>
            <Tabs<Browser>
              value={browser}
              onChange={setBrowser}
              items={[
                { value: 'chrome', label: 'Chrome', icon: <Globe size={16} /> },
                { value: 'edge', label: 'Edge', icon: <Globe size={16} /> },
                { value: 'opera', label: 'Opera', icon: <Globe size={16} /> },
                { value: 'safari', label: 'Safari', icon: <Globe size={16} /> },
              ]}
            />
            {browser === 'safari' ? (
              <div className="vf-stack">
                <Alert tone="warning" title="Em breve">
                  A versão para Safari ainda não está disponível. Use o Chrome, o Edge ou o Opera.
                </Alert>
                <div>
                  <Button kind="secondary" disabled title="Em breve">
                    Acessar
                  </Button>
                </div>
              </div>
            ) : (
              <ol className="vf-ecac-timeline">
                <Step n={1} title="Baixe e descompacte a extensão">
                  <div className="vf-stack" style={{ '--gap': '8px' } as React.CSSProperties}>
                    <span>Guarde a pasta descompactada num lugar fixo: o navegador carrega a extensão a partir dela.</span>
                    <div>
                      <Button size="sm" icon={<Download />} loading={busy === 'extension'} onClick={() => void download('extension')}>
                        Baixar extensão (.zip)
                      </Button>
                    </div>
                  </div>
                </Step>
                <Step n={2} title="Ative o modo do desenvolvedor">
                  Abra <span className="vf-mono">{EXT_PAGE[browser]}</span> na barra de endereços e ligue “Modo do desenvolvedor”.
                </Step>
                <Step n={3} title="Carregue sem compactação">
                  Clique em “Carregar sem compactação” (ou “Carregar expandida”) e escolha a pasta descompactada.
                </Step>
                <Step n={4} title="Conecte ao Verifco">
                  Clique no ícone da extensão, informe o endereço da API <span className="vf-mono">{base}</span>, o endereço desta página e um token do tipo “Extensão”. Use “Testar conexão”.
                </Step>
                <Step n={5} title="Use no cliente">
                  Na aba “Ações eCAC” de um cliente, clique em “Acessar”. A extensão abre o serviço do eCAC numa nova aba.
                </Step>
              </ol>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li>
      <span className="vf-ecac-timeline__n">{n}</span>
      <div className="vf-stack" style={{ '--gap': '4px', minWidth: 0 } as React.CSSProperties}>
        <div className="vf-text-sm-bold">{title}</div>
        <div className="vf-muted">{children}</div>
      </div>
    </li>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="vf-ecac-cmd">{children}</code>;
}

