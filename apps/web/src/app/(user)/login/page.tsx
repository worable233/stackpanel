import { redirect } from 'next/navigation';
import { LoginForm } from './login-form';
import { getApiClient } from '@/lib/api';
import { getSessionUser } from '@/lib/auth';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const session = await getSessionUser();
  if (session) {
    redirect(
      typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')
        ? next
        : session.role === 'ADMIN'
          ? '/admin'
          : '/account',
    );
  }
  const nextPath =
    typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : undefined;
  const providers = await getApiClient()
    .getOAuthProviders()
    .then((result) => result.providers)
    .catch(() => []);
  return (
    <LoginForm
      nextPath={nextPath}
      hasWowId={providers.some((provider) => provider.id === 'wowid')}
    />
  );
}
