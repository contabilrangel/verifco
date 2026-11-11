import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Link, Outlet, RouterProvider, createMemoryRouter } from 'react-router';
import { ChunkLoadError } from '../lib/lazy';
import { ErrorBoundary, RouteError } from './ErrorBoundary';

/** Tela de erro no lugar da página em branco: barreira do React e `errorElement` das rotas. */
function Boom({ error = new Error('x is not a function') }: { error?: Error }): never {
  throw error;
}

describe('tela de erro', () => {
  beforeEach(() => {
    // o React e o roteador registram no console os erros capturados
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('ErrorBoundary: mostra "Recarregar" e "Voltar ao início" quando a página quebra', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Algo deu errado nesta página' })).toBeTruthy();
    expect(screen.getByText(/Detalhe para o suporte: x is not a function/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar ao início' }).getAttribute('href')).toBe('/');
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('arquivo do aplicativo que não baixou (deploy): pede para recarregar, sem detalhe técnico', () => {
    render(
      <ErrorBoundary>
        <Boom error={new ChunkLoadError(new TypeError('Failed to fetch dynamically imported module'))} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('heading', { name: 'Não foi possível carregar esta página' })).toBeTruthy();
    expect(screen.getByText(/O Verifco foi atualizado ou a conexão falhou/)).toBeTruthy();
    expect(screen.queryByText(/Detalhe para o suporte/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Recarregar' })).toBeTruthy();
  });

  it('navegar para outra página (resetKey) desfaz o erro', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/a">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    rerender(
      <ErrorBoundary resetKey="/b">
        <p>Outra página</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('Outra página')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('errorElement: o erro de uma página aparece dentro da moldura, e as outras páginas continuam abrindo', async () => {
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: (
            <div>
              <nav>
                <Link to="/ok">Página boa</Link>
              </nav>
              <Outlet />
            </div>
          ),
          children: [
            {
              errorElement: <RouteError />,
              children: [
                { path: 'quebrada', element: <Boom /> },
                { path: 'ok', element: <p>Tudo certo</p> },
              ],
            },
          ],
        },
      ],
      { initialEntries: ['/quebrada'] },
    );
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole('heading', { name: 'Algo deu errado nesta página' })).toBeTruthy();
    // a moldura (menu) continua na tela
    fireEvent.click(screen.getByRole('link', { name: 'Página boa' }));
    expect(await screen.findByText('Tudo certo')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
