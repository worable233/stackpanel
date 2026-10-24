import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ApiError } from '@stackpanel/sdk';
import { getAuthedApiClient } from '@/lib/api';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

/** BFF proxy for a selected upstream product's optional checkout configuration. */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ provider: string; productId: string }> },
) {
  const t = createTranslator(await getLocale());
  try {
    const { provider, productId } = await context.params;
    const sourceRef = request.nextUrl.searchParams.get('sourceRef') ?? undefined;
    const api = await getAuthedApiClient();
    const result = await api.getUpstreamProductConfig(provider, productId, { sourceRef });
    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    if (status === 401) {
      return NextResponse.json({ error: t('common.notLoggedIn') }, { status: 401 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : t('api.upstreamProductsUnavailable') },
      { status },
    );
  }
}
