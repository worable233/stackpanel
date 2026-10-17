import { redirect } from 'next/navigation';

export default function AccountSecurityPage() {
  redirect('/account/settings#security');
}
