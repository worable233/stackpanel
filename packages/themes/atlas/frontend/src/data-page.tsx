import { formatMinorCurrency, PACKAGE_FALLBACK_LOCALE, type FrontendPageProps } from '@stackpanel/sdk';
import { Badge } from '@stackpanel/ui';
import { ArrowLeft, ArrowUpRight, Gauge } from 'lucide-react';
import type { ReactElement } from 'react';
import { t } from './i18n.js';

interface ModelPrice {
  model: string;
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number;
  cacheWritePrice: number;
  multiplier: number;
  capabilities: string[];
}

interface ModelPriceCatalog {
  currency: string;
  unitTokens: number;
  prices: ModelPrice[];
}

function price(amount: number, currency: string, unitTokens: number, locale?: string): string {
  try {
    const unit = unitTokens >= 1_000_000 ? `${unitTokens / 1_000_000}M` : String(unitTokens);
    return `${formatMinorCurrency(amount, currency, locale ?? PACKAGE_FALLBACK_LOCALE)} / ${unit}`;
  } catch {
    return String(amount);
  }
}

export function AtlasDataPage({ data, locale }: FrontendPageProps): ReactElement {
  const tr = t(locale);
  const catalog = data.modelPrices as ModelPriceCatalog | undefined;
  const prices = catalog?.prices ?? [];

  if (!catalog || prices.length === 0) {
    return (
      <main className="flex-1">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start px-4 py-16 sm:px-6 lg:py-24">
          <span className="rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground">
            404
          </span>
          <h1 className="mt-5 text-3xl font-medium tracking-tight sm:text-4xl">
            {tr('data.unavailableTitle')}
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
            {tr('data.unavailableText')}
          </p>
          <a
            href="/"
            className="mt-8 inline-flex items-center gap-2 rounded-lg bg-muted px-4 py-2 text-sm transition-colors hover:bg-muted/70"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            {tr('data.backHome')}
          </a>
        </div>
      </main>
    );
  }

  const inputPrices = prices.map((item) => item.inputPrice).filter((value) => value > 0);
  const outputPrices = prices.map((item) => item.outputPrice).filter((value) => value > 0);
  const capabilities = new Set(prices.flatMap((item) => item.capabilities));
  const cheapestInput = inputPrices.length ? Math.min(...inputPrices) : 0;
  const cheapestOutput = outputPrices.length ? Math.min(...outputPrices) : 0;
  const stats = [
    { label: tr('data.models'), value: String(prices.length) },
    { label: tr('data.capabilities'), value: String(capabilities.size) },
    {
      label: tr('data.cheapestInput'),
      value: price(cheapestInput, catalog.currency, catalog.unitTokens, locale),
    },
    {
      label: tr('data.cheapestOutput'),
      value: price(cheapestOutput, catalog.currency, catalog.unitTokens, locale),
    },
  ];

  return (
    <main className="flex-1">
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:py-16">
        <a
          href="/"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {tr('data.backHome')}
        </a>

        <header className="mt-8 max-w-3xl">
          <span className="text-sm font-medium text-muted-foreground">{tr('data.kicker')}</span>
          <h1 className="mt-6 text-4xl font-medium tracking-tight text-balance sm:text-5xl">
            {tr('data.title')}
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
            {tr('data.lead')}
          </p>
        </header>

        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-2xl bg-muted/50 p-5">
              <p className="text-xs text-muted-foreground">{stat.label}</p>
              <p className="mt-2 truncate text-xl font-medium tracking-tight tabular-nums">
                {stat.value}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-10 overflow-hidden rounded-[24px] bg-muted/35">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <p className="text-sm font-medium">{tr('data.tableTitle')}</p>
            <p className="text-xs text-muted-foreground">
              {tr('data.unitNote', { unit: String(catalog.unitTokens) })}
            </p>
          </div>
          <div className="overflow-x-auto bg-background/70">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th className="px-5 py-3 font-medium">{tr('data.model')}</th>
                  <th className="px-5 py-3 font-medium">{tr('data.input')}</th>
                  <th className="px-5 py-3 font-medium">{tr('data.output')}</th>
                  <th className="px-5 py-3 font-medium">{tr('data.cache')}</th>
                  <th className="px-5 py-3 font-medium">{tr('data.capability')}</th>
                </tr>
              </thead>
              <tbody>
                {prices.map((item) => (
                  <tr key={item.model} className="align-top transition-colors hover:bg-muted/40">
                    <td className="px-5 py-4 font-medium">{item.model}</td>
                    <td className="px-5 py-4 tabular-nums">
                      {price(item.inputPrice, catalog.currency, catalog.unitTokens, locale)}
                    </td>
                    <td className="px-5 py-4 tabular-nums">
                      {price(item.outputPrice, catalog.currency, catalog.unitTokens, locale)}
                    </td>
                    <td className="px-5 py-4 text-xs text-muted-foreground tabular-nums">
                      {tr('data.read')}{' '}
                      {price(item.cacheReadPrice, catalog.currency, catalog.unitTokens, locale)}
                      <br />
                      {tr('data.write')}{' '}
                      {price(item.cacheWritePrice, catalog.currency, catalog.unitTokens, locale)}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex flex-wrap gap-1.5">
                        {item.capabilities.slice(0, 4).map((capability) => (
                          <Badge key={capability} className="px-2 py-1">
                            {capability}
                          </Badge>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
          <p className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Gauge className="size-4" aria-hidden="true" />
            {tr('data.source')}
          </p>
          <a href="/shop" className="inline-flex items-center gap-2 text-sm font-medium">
            {tr('data.explore')}
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </a>
        </div>
      </div>
    </main>
  );
}
