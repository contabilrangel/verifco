import { Navigate, Outlet, RouterProvider, createBrowserRouter, useLocation } from 'react-router';
import { Loading } from '../ds';
import { useAuth } from '../lib/auth';
import { ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage } from '../modules/auth/AuthPages';
import { Shell } from './Shell';
import { APP_ROUTES, PUBLIC_ROUTES } from './routes';
import { PlatformPanel } from '../modules/platform/PlatformPanel';

function RequireAuth() {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading label="Abrindo o Verifco..." />;
  if (!me) return <Navigate to="/entrar" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

function GuestOnly() {
  const { me, loading } = useAuth();
  if (loading) return <Loading />;
  return me ? <Navigate to="/" replace /> : <Outlet />;
}

const router = createBrowserRouter([
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
  ...PUBLIC_ROUTES,
  {
    element: <RequireAuth />,
    children: [{ path: '/', element: <Shell />, children: APP_ROUTES }],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

export function App() {
  return <RouterProvider router={router} />;
}
