import { Navigate, Outlet, RouterProvider, createBrowserRouter, useLocation } from 'react-router';
import { Loading } from '../ds';
import { returnPath, useAuth } from '../lib/auth';
import { ConfirmEmailPage, ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage } from '../modules/auth/AuthPages';
import { RouteError } from './ErrorBoundary';
import { NotFound } from './NotFound';
import { Shell } from './Shell';
import { APP_ROUTES, PUBLIC_ROUTES } from './routes';
import { lazyPage } from '../lib/lazy';

/** Painel da equipe do sistema: fora do pacote que todo escritório baixa. */
const PlatformPanel = lazyPage(() => import('../modules/platform/PlatformPanel'), 'PlatformPanel');

/** Rotas do escritório: sem sessão, vai ao login levando o endereço pedido (com busca e âncora) para voltar depois. */
export function RequireAuth() {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading label="Abrindo o Verifco..." />;
  if (!me) return <Navigate to="/entrar" replace state={{ from: location.pathname + location.search + location.hash }} />;
  return <Outlet />;
}

/** Telas de acesso: quem já entrou segue para a página que tinha pedido (ou para o início). */
export function GuestOnly() {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  return me ? <Navigate to={returnPath(location.state) ?? '/'} replace /> : <Outlet />;
}

/**
 * Endereço que nenhuma rota conhece: página "não encontrada" em vez de voltar calado ao início.
 * Quem está na conta do escritório vê a página dentro do Shell; os demais, a versão pública.
 */
export function UnknownRoute() {
  const { me, loading } = useAuth();
  if (loading) return <Loading label="Abrindo o Verifco..." />;
  if (!me) return <NotFound variant="public" backTo="/entrar" backLabel="Ir para o login" />;
  return (
    <Shell>
      <NotFound />
    </Shell>
  );
}

/**
 * Erros ao desenhar: os das páginas do escritório aparecem dentro do Shell (rota sem caminho com
 * `errorElement`, em volta das rotas dos módulos); os demais, na tela inteira.
 */
const router = createBrowserRouter([
  {
    errorElement: <RouteError fullPage />,
    children: [
      { path: '/sistema/*', element: <PlatformPanel /> },
      {
        element: <GuestOnly />,
        children: [
          { path: '/entrar', element: <LoginPage /> },
          { path: '/cadastro', element: <RegisterPage /> },
          { path: '/esqueci-senha', element: <ForgotPasswordPage /> },
        ],
      },
      { path: '/redefinir-senha', element: <ResetPasswordPage /> },
      { path: '/confirmar-email', element: <ConfirmEmailPage /> },
      ...PUBLIC_ROUTES,
      {
        element: <RequireAuth />,
        children: [{ path: '/', element: <Shell />, children: [{ errorElement: <RouteError />, children: APP_ROUTES }] }],
      },
      { path: '*', element: <UnknownRoute /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
