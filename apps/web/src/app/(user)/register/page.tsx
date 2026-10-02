import { redirect } from 'next/navigation';
import { RegisterForm } from './register-form';
import { getSessionUser } from '@/lib/auth';

export default async function RegisterPage() {
  const session = await getSessionUser();
  if (session) {
    redirect(session.role === 'ADMIN' ? '/admin' : '/account');
  }
  return <RegisterForm />;
}
