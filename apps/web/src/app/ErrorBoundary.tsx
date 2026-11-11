import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button, Card, EmptyState } from '../ds';
import { isChunkLoadError } from '../lib/lazy';
import { NotFound, PublicFrame } from './NotFound';

/**
 * Tela de erro: a página quebrou ao desenhar, ou um arquivo do aplicativo não pôde ser baixado
 * (versão nova publicada, conexão ruim). "Recarregar" busca a versão atual; "Voltar ao início"
 * abre a página inicial do zero.
 */
export function ErrorScreen({ error, fullPage }: { error: unknown; fullPage?: boolean }) {
  const chunk = isChunkLoadError(error);
  const detail = !chunk && error instanceof Error && error.message ? error.message.slice(0, 300) : null;
  const body = (
    <EmptyState
      icon={<AlertTriangle />}
      title={<h1 className="vf-text-md-bold">{chunk ? 'Não foi possível carregar esta página' : 'Algo deu errado nesta página'}</h1>}
      description={
        <div className="vf-stack" style={{ '--gap': '8px' } as React.CSSProperties}>
          <span>
            {chunk
              ? 'O Verifco foi atualizado ou a conexão falhou enquanto a página era carregada. Recarregue para continuar.'
              : 'Ocorreu um erro inesperado e a página não pôde ser exibida. Recarregue; se o erro continuar, volte ao início e avise o suporte.'}
          </span>
          {detail && <span className="shell-fallback__detail">Detalhe para o suporte: {detail}</span>}
        </div>
      }
      action={
        <div className="vf-inline" style={{ justifyContent: 'center' }}>
          <Button icon={<RefreshCw />} onClick={() => window.location.reload()}>
            Recarregar
          </Button>
          {/* link comum (não do roteador): recomeça o aplicativo do zero */}
          <a className="vf-btn vf-btn--secondary" href="/">
            Voltar ao início
          </a>
        </div>
      }
    />
  );
  return (
    <div role="alert">
      {fullPage ? <PublicFrame>{body}</PublicFrame> : <Card>{body}</Card>}
    </div>
  );
}

/**
 * Barreira de erros do React em volta do conteúdo das páginas: um erro ao desenhar mostra a tela
 * de erro no lugar da página, com menu e barra superior no lugar. `resetKey` (o endereço) desfaz
 * o erro quando a pessoa navega para outra página.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: unknown; fullPage?: boolean }, { failed: boolean; error: unknown }> {
  state = { failed: false, error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Erro ao desenhar a página', error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false, error: null });
  }

  render() {
    return this.state.failed ? <ErrorScreen error={this.state.error} fullPage={this.props.fullPage} /> : this.props.children;
  }
}

/** `errorElement` das rotas: erro de uma página (dentro do Shell) ou do aplicativo todo (`fullPage`). */
export function RouteError({ fullPage }: { fullPage?: boolean }) {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound variant={fullPage ? 'public' : 'page'} />;
  return <ErrorScreen error={error} fullPage={fullPage} />;
}
