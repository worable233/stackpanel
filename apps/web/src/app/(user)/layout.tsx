import { PublicThemeShell } from '@/components/frontend-route';

export default function UserLayout({ children }: { children: React.ReactNode }) {
  return <PublicThemeShell>{children}</PublicThemeShell>;
}
