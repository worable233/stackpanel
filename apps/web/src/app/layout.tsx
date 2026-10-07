import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { headers } from 'next/headers';
import { DEFAULT_PLATFORM_INFO } from '@stackpanel/sdk';
import { ThemeProvider } from '@/components/theme-provider';
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
  // Per-request CSP nonce set by `src/proxy.ts`; the inline theme bootstrap below
  // is the only manual inline script, and it needs the nonce to satisfy the
  // strict `script-src` policy.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html
      lang={locale}
      className={`h-full antialiased ${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        {/* Runs before first paint and before hydration; never rendered by a
            client component, so React does not warn about an unexecuted script.
            React intentionally reports a `nonce` mismatch on hydration (it does
            not re-apply nonces), which is harmless here — suppress it. */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: themeBootstrapScript }}
        />
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
