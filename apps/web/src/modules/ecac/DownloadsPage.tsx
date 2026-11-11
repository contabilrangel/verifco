import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Download, FolderSync, Globe, Laptop, Monitor, Puzzle, Terminal } from 'lucide-react';
import { Button, Card, Tag, Tabs, useToast } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { apiBaseUrl } from './ui';

type Os = 'windows' | 'macos' | 'linux';
type Browser = 'chrome' | 'edge' | 'opera';

/** Versões dos pacotes que a Central entrega (apps/sync e apps/extension). */
export const SYNC_VERSION = '0.3.0';
export const EXTENSION_VERSION = '0.2.0';

const SYNC_FOLDER: Record<Os, string> = { windows: 'C:\\Verifco\\sincronizador', macos: '~/Verifco/sincronizador', linux: '~/verifco-sincronizador' };
const TERMINAL: Record<Os, string> = { windows: 'Prompt de Comando', macos: 'Terminal', linux: 'terminal' };
/** Atalho da linha de comando em cada sistema (os dois arquivos vêm no .zip). */
const CLI: Record<Os, string> = { windows: 'verifco-sync', macos: 'sh verifco-sync.sh', linux: 'sh verifco-sync.sh' };
const AUTOSTART: Record<Os, string> = {
  windows: 'cria uma tarefa agendada que inicia o sincronizador ao fazer logon no Windows, sem abrir janela.',
  macos: 'mostra o LaunchAgent a criar para iniciar junto com o macOS (nada é gravado no sistema).',
  linux: 'mostra o serviço de usuário do systemd a criar para iniciar junto com a sessão (nada é gravado no sistema).',
};
const EXT_PAGE: Record<Browser, string> = { chrome: 'chrome://extensions', edge: 'edge://extensions', opera: 'opera://extensions' };

export function DownloadsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [os, setOs] = useState<Os>(() => (/Mac/i.test(navigator.platform) ? 'macos' : /Linux/i.test(navigator.platform) ? 'linux' : 'windows'));
  const [browser, setBrowser] = useState<Browser>(() => (/Edg\//.test(navigator.userAgent) ? 'edge' : /OPR\//.test(navigator.userAgent) ? 'opera' : 'chrome'));
  const [busy, setBusy] = useState<string | null>(null);
  const base = apiBaseUrl();
  const web = window.location.origin;
  const robot = can('ecac.robot') ? <Link to="/admin/robo">Meu escritório › Robô</Link> : 'Meu escritório › Robô';

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
        <Card
          title={
            <span className="vf-inline">
              <FolderSync size={20} /> Sincronizador Verifco <Tag>versão {SYNC_VERSION}</Tag>
            </span>
          }
        >
          <div className="vf-stack">
            <span className="vf-muted">
              Roda no computador onde o programa IRPF é usado. Envia ao Verifco os arquivos das declarações (.DEC, .REC, .DBK) e das pré-preenchidas, que ficam guardados nos documentos do cliente identificado pelo CPF do nome do arquivo. O Verifco não interpreta o conteúdo desses arquivos: o sincronizador lê só o começo de cada um, para conferir se o CPF de dentro é o mesmo do nome, e o recibo (.REC) marca a declaração como transmitida.
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
              <Step n={3} title="Configure com o assistente">
                Crie um token do tipo “Sincronizador” em {robot}. No {TERMINAL[os]}, dentro da pasta, rode:
                <Code>{`${CLI[os]} configurar`}</Code>
                O assistente pergunta o endereço do Verifco (<span className="vf-mono">{web}</span>), o token e as pastas, e testa a conexão. Na primeira vez, o atalho{' '}
                <span className="vf-mono">{os === 'windows' ? 'verifco-sync.cmd' : 'verifco-sync.sh'}</span> instala as dependências sozinho.
              </Step>
              <Step n={4} title="Confira as pastas observadas">
                <Code>{`${CLI[os]} pastas`}</Code>
                Por padrão, observamos as pastas do programa IRPF do ano atual e do anterior que existirem neste computador. Para incluir outra:{' '}
                <Code>{`${CLI[os]} config --pasta "${os === 'windows' ? 'D:\\Declaracoes' : '~/Declaracoes'}"`}</Code>
              </Step>
              <Step n={5} title="Inicie">
                <Code>{`${CLI[os]} iniciar`}</Code>
                Faz uma varredura inicial e depois envia cada arquivo novo ou alterado.
              </Step>
              <Step n={6} title="Inicie junto com o computador (opcional)">
                <Code>{`${CLI[os]} instalar`}</Code>
                Este comando {AUTOSTART[os]}
              </Step>
            </ol>
          </div>
        </Card>

        <Card
          title={
            <span className="vf-inline">
              <Puzzle size={20} /> Extensão Verifco <Tag>versão {EXTENSION_VERSION}</Tag>
            </span>
          }
        >
          <div className="vf-stack">
            <span className="vf-muted">
              Abre os serviços do eCAC a partir da aba “Ações eCAC” do cliente e envia ao Verifco o que você escolher. Tudo é feito por ação sua: a extensão não lê as páginas sozinha nem preenche nada no eCAC. Funciona no Chrome, no Edge e no Opera; não há versão para Safari.
            </span>
            <Tabs<Browser>
              value={browser}
              onChange={setBrowser}
              items={[
                { value: 'chrome', label: 'Chrome', icon: <Globe size={16} /> },
                { value: 'edge', label: 'Edge', icon: <Globe size={16} /> },
                { value: 'opera', label: 'Opera', icon: <Globe size={16} /> },
              ]}
            />
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
                Clique no ícone da extensão, abra “Configuração” e informe o endereço do Verifco (<span className="vf-mono">{web}</span>) e um token do tipo “Extensão”, criado em {robot}.
                {base !== web && (
                  <>
                    {' '}
                    Em “Endereço da API”, informe <span className="vf-mono">{base}</span>.
                  </>
                )}{' '}
                Use “Salvar” e “Testar conexão”.
              </Step>
              <Step n={5} title="Use no cliente">
                Na aba “Ações eCAC” de um cliente, clique em “Acessar”. A extensão abre o serviço do eCAC numa nova aba, com um aviso do cliente em atendimento.
              </Step>
            </ol>
            <div className="vf-stack" style={{ '--gap': '8px' } as React.CSSProperties}>
              <strong className="vf-text-sm-bold">O que dá para enviar pela extensão</strong>
              <ul className="vf-muted" style={{ margin: 0, paddingLeft: 20 }}>
                <li>
                  <strong>Enviar arquivo ao cliente:</strong> no ícone da extensão, escolha o cliente, o arquivo (até 25 MB), o exercício e a categoria; dá para marcar que é a pré-preenchida.
                </li>
                <li>
                  <strong>Registrar esta página:</strong> guarda o título, o endereço e o texto da página aberta (ou do trecho selecionado) e, se você quiser, uma imagem da tela.
                </li>
                <li>
                  <strong>Situação da declaração e CND:</strong> formulários para registrar a situação da declaração (com o número do recibo) e a CND (situação, validade e código de controle).
                </li>
                <li>
                  <strong>Botão direito do mouse:</strong> “Enviar seleção ao Verifco”, “Enviar este link/arquivo ao Verifco” e, num PDF aberto, “Enviar este PDF ao Verifco”.
                </li>
              </ul>
            </div>
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

