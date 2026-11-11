import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { SESSION_EXPIRED_MESSAGE } from '../../lib/api';
import { ToastProvider, useToast } from '../../ds';
import { LoginPage } from './AuthPages';

/** Login: aviso de sessão expirada e volta para a página que pediu o login. */
const auth = vi.hoisted(() => ({ sessionExpired: false, login: vi.fn(async (_email: string, _password: string) => {}) }));

vi.mock('../../lib/auth', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/auth')>();
  return { ...original, useAuth: () => ({ login: auth.login, sessionExpired: auth.sessionExpired }) };
});

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search + location.hash}</p>;
}

/** Uma requisição falha por 401 (aviso de erro) e, no mesmo instante, a sessão cai e o login aparece. */
function SessionDrop() {
  const toast = useToast();
  const [dropped, setDropped] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          toast.error('Erro da requisição que caiu com a sessão');
          setDropped(true);
        }}
      >
        derrubar sessão
      </button>
      {dropped && (
        <MemoryRouter initialEntries={['/entrar']}>
          <LoginPage />
        </MemoryRouter>
      )}
    </>
  );
}

const renderLogin = (state?: unknown) =>
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[{ pathname: '/entrar', state }]}>
        <Routes>
          <Route path="/entrar" element={<LoginPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );

const submit = () => {
  fireEvent.change(screen.getByLabelText(/E-mail/), { target: { value: 'ana@exemplo.com.br' } });
  fireEvent.change(screen.getByLabelText(/^Senha/), { target: { value: 'senha-forte' } });
  fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
};

describe('LoginPage', () => {
  beforeEach(() => {
    auth.sessionExpired = false;
    auth.login.mockReset();
    auth.login.mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it('sessão expirada: explica por que a pessoa voltou ao login', () => {
    auth.sessionExpired = true;
    renderLogin({ from: '/clientes' });
    expect(screen.getByRole('status').textContent).toContain('Sua sessão expirou. Entre de novo para continuar.');
  });

  it('login normal (ou depois de "Sair"): sem aviso', () => {
    renderLogin();
    expect(screen.queryByText(SESSION_EXPIRED_MESSAGE)).toBeNull();
  });

  it('depois de entrar, volta para a página guardada (com a busca), trocando a entrada do login no histórico', async () => {
    renderLogin({ from: '/clientes?busca=ana&pagina=2' });
    submit();
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/clientes?busca=ana&pagina=2'));
    expect(auth.login).toHaveBeenCalledWith('ana@exemplo.com.br', 'senha-forte');
  });

  it('sem página guardada, ou com endereço de outro site, vai ao início', async () => {
    renderLogin();
    submit();
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/'));

    for (const from of ['https://exemplo.com/roubo', '//exemplo.com', '/entrar']) {
      cleanup();
      renderLogin({ from });
      submit();
      await waitFor(() => expect(screen.getByTestId('where').textContent, from).toBe('/'));
    }
  });

  it('senha errada: mostra o erro da API no lugar do aviso de sessão e continua no login', async () => {
    auth.sessionExpired = true;
    auth.login.mockRejectedValue(new Error('E-mail ou senha incorretos.'));
    renderLogin({ from: '/clientes' });
    submit();
    expect((await screen.findByRole('alert')).textContent).toContain('E-mail ou senha incorretos.');
    expect(screen.queryByText(SESSION_EXPIRED_MESSAGE)).toBeNull();
    expect(screen.queryByTestId('where')).toBeNull();
  });

  it('ao cair no login por sessão expirada, os avisos de erro da sessão anterior saem da tela', async () => {
    auth.sessionExpired = true;
    render(
      <ToastProvider>
        <SessionDrop />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('derrubar sessão'));
    expect(await screen.findByText(SESSION_EXPIRED_MESSAGE)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Erro da requisição que caiu com a sessão')).toBeNull());
  });
});
