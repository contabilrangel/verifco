import { PageHeader } from '../../app/Shell';
import { useAuth } from '../../lib/auth';

export function HomePage() {
  const { me } = useAuth();
  return <PageHeader title="Dashboard" description={`Bem-vindo, ${me?.user.name ?? ''}.`} />;
}
