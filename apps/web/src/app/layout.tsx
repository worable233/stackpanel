import type { Metadata } from 'next';
import { getClarityMotionBootstrapScript } from '@stackpanel/ui';
import localFont from 'next/font/local';
import { headers } from 'next/headers';
import { DEFAULT_PLATFORM_INFO } from '@stackpanel/sdk';
import { ThemeProvider } from '@/components/theme-provider';
import { ThemeInitScript } from '@/components/theme-init-script';
import { Toaster } from '@/components/ui/sonner';
import ThemeStylesheet from '@/components/theme-stylesheet';
import { I18nProvider } from '@/i18n/provider';
import { getLocale } from '@/i18n/locale';
import { apiAssetUrl, getApiClient } from '@/lib/api';
import { themeBootstrapScript } from '@/lib/theme';
import './globals.css';

const geistSans = localFont({
  src: '../fonts/GeistSans-Variable.woff2',
  variable: '--font-geist-sans',
  display: 'swap',
});

const geistMono = localFont({
  src: '../fonts/GeistMono-Variable.woff2',
  variable: '--font-geist-mono',
  display: 'swap',
});

export async function generateMetadata(): Promise<Metadata> {
  const [platform, brand] = await Promise.all([
    getApiClient()
      .getPlatformInfo()
      .then((result) => result.platform)
      .catch(() => DEFAULT_PLATFORM_INFO),
    getApiClient()
      .getPlatformBrand()
      .then((result) => result.brand)
      .catch(() => null),
  ]);
  const favicon = brand?.favicon ? apiAssetUrl(brand.favicon) : null;
  return {
    title: platform.name,
    description: platform.description,
    ...(platform.url ? { metadataBase: new URL(platform.url) } : {}),
    ...(favicon
      ? {
          icons: {
            icon: favicon,
            shortcut: favicon,
            apple: favicon,
          },
        }
      : {}),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html
      lang={locale}
      className={`h-full antialiased has-[.clarity-surface]:bg-[var(--clarity-background)] has-[.clarity-surface]:[color-scheme:dark]! [@media(pointer:fine)]:has-[.clarity-surface]:[scrollbar-width:none] [@media(pointer:fine)]:has-[.clarity-surface]:[&::-webkit-scrollbar]:hidden ${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body
        className="min-h-full flex flex-col has-[.clarity-surface]:bg-[var(--clarity-background)]"
        suppressHydrationWarning
      >
        <ThemeInitScript nonce={nonce} script={themeBootstrapScript} />
        <ThemeInitScript nonce={nonce} script={getClarityMotionBootstrapScript()} />
        <ThemeStylesheet />
        <I18nProvider locale={locale}>
          <ThemeProvider>
            {children}
            <Toaster />
          </ThemeProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
