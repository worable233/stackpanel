import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ApiError } from '@stackpanel/sdk';
import { getAuthedApiClient } from '@/lib/api';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

/** BFF proxy for GET /store/upstream-products/:provider?q= (store product form). */
export async function GET(request: NextRequest) {
  const t = createTranslator(await getLocale());
  try {
    const provider = request.nextUrl.searchParams.get('provider');
    const q = request.nextUrl.searchParams.get('q') ?? '';
    if (!provider) {
      return NextResponse.json({ error: t('api.missingUpstreamProvider') }, { status: 400 });
    }
    const api = await getAuthedApiClient();
    const result = await api.searchUpstreamProducts(provider, q);
    return NextResponse.json(result);
  } catch (error) {
    const status =
      error instanceof ApiError
        ? error.status
        : error instanceof Error && 'status' in error
          ? Number(error.status)
          : 500;
    const message = error instanceof Error ? error.message : t('api.upstreamProductsUnavailable');
    if (status === 401) {
      return NextResponse.json({ error: t('common.notLoggedIn') }, { status: 401 });
    }
    return NextResponse.json(
      { error: message, ...(error instanceof ApiError ? { code: error.code } : {}) },
      { status: 500 },
    );
  }
}
