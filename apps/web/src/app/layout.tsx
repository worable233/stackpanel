import type { Metadata } from 'next';
import { getClarityMotionBootstrapScript } from '@stackpanel/ui';
import localFont from 'next/font/local';
import { headers } from 'next/headers';
import { DEFAULT_PLATFORM_INFO } from '@stackpanel/sdk';
import { ThemeProvider } from '@/components/theme-provider';
import { ThemeInitScript } from '@/components/theme-init-script';
import { Toaster } from '@/components/ui/sonner';
import ThemeStylesheet from '@/components/theme-stylesheet';
import FrontendStylesheets from '@/components/frontend-stylesheets';
import { FrontendAbiBridge } from '@/components/frontend-abi-bridge';
import { ActionFeedbackToaster } from '@/components/action-feedback-toaster';
import { I18nProvider } from '@/i18n/provider';
import { getLocale } from '@/i18n/locale';
import { apiAssetUrl } from '@/lib/api';
import { themeBootstrapScript } from '@/lib/theme';
import { isProvisioningMode } from '@/lib/provisioning';
import { requestPlatformInfo, requestPlatformBrand } from '@/lib/platform-request-cache';
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
  // During first boot the provision API only serves health + setup: platform
  // info and branding do not exist yet, so asking would log a 404 per page
  // render. The static defaults are exactly what the setup page should show.
  if (isProvisioningMode()) {
    return {
      title: DEFAULT_PLATFORM_INFO.name,
      description: DEFAULT_PLATFORM_INFO.description,
    };
  }
  const [platform, brand] = await Promise.all([
    requestPlatformInfo(),
    requestPlatformBrand(),
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
      className={`h-full overflow-y-scroll antialiased [scrollbar-gutter:stable_both-edges] has-[.clarity-surface]:bg-[var(--clarity-background)] has-[.clarity-surface]:[color-scheme:dark]! [@media(pointer:fine)]:has-[.clarity-surface]:[scrollbar-width:none] [@media(pointer:fine)]:has-[.clarity-surface]:[&::-webkit-scrollbar]:hidden ${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body
        className="min-h-full flex flex-col has-[.clarity-surface]:bg-[var(--clarity-background)]"
        suppressHydrationWarning
      >
        <ThemeInitScript nonce={nonce} script={themeBootstrapScript} />
        <ThemeInitScript nonce={nonce} script={getClarityMotionBootstrapScript()} />
        <ThemeStylesheet />
        <FrontendStylesheets />
        <FrontendAbiBridge />
        <I18nProvider locale={locale}>
          <ThemeProvider>
            {children}
            <Toaster />
            {/* Global：`?action=…&error|success=<code>`（只认 code，文案查表）。
                动态文本走一次性 flash，不进 URL——见 lib/action-feedback-codes.ts。 */}
            <ActionFeedbackToaster />
          </ThemeProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
