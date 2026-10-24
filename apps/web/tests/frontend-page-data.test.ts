import { describe, expect, it, vi } from 'vitest';
import type { ApiClient, FinderProvider, FrontendPageDataRequirement } from '@stackpanel/sdk';
import {
  executePageData,
  MissingRouteParamError,
  resolveFetchPath,
  resolveRequirementInput,
} from '@/lib/frontend-page-data';

/**
 * Contract: a page-data requirement has two forms, and they are a trust
 * boundary rather than a style choice.
 *
 * - `{ fetch }` is performed by the host. It must succeed for a package that
 *   was **not** admitted to server execution (that is the whole point: a
 *   third-party plugin can render a populated first screen without running
 *   code in the web process).
 * - `{ finder }` runs package code and therefore only appears when the caller
 *   passed an admitted finder map.
 *
 * These tests pin both halves plus the failure semantics (one bad requirement
 * must not blank the whole page).
 */

const settings = {} as never;

/** A finder map that should never be reached by a `fetch` requirement. */
const forbiddenFinders: Record<string, FinderProvider> = {
  'ticket.adminSummary': {
    handler: () => {
      throw new Error('finder must not run for a declarative requirement');
    },
  },
};

function options(overrides: Partial<Parameters<typeof executePageData>[1]> = {}) {
  return {
    params: {} as Record<string, string>,
    settings,
    session: { role: 'ADMIN' as const },
    api: {} as ApiClient,
    isAllowed: async () => true,
    finders: forbiddenFinders,
    ...overrides,
  };
}

describe('executePageData: declarative fetch', () => {
  it('runs a fetch requirement without any admitted finder', async () => {
    const fetchJson = vi.fn(async () => ({ total: 3 }));
    const requirements: FrontendPageDataRequirement[] = [
      { as: 'summary', fetch: { path: '/ticket/admin/tickets?page=1&pageSize=5' } },
    ];

    const data = await executePageData(requirements, options({ finders: {}, fetchJson }));

    expect(fetchJson).toHaveBeenCalledWith('/ticket/admin/tickets?page=1&pageSize=5');
    expect(data).toEqual({ summary: { total: 3 } });
  });

  it('interpolates :param from the route into the path', async () => {
    const fetchJson = vi.fn(async () => ({ id: 't-1' }));
    const requirements: FrontendPageDataRequirement[] = [
      { as: 'ticket', fetch: { path: '/tickets/:id' } },
    ];

    const data = await executePageData(requirements, options({ params: { id: 't-1' }, fetchJson }));

    expect(fetchJson).toHaveBeenCalledWith('/tickets/t-1');
    expect(data).toEqual({ ticket: { id: 't-1' } });
  });

  it('lets a URL query parameter override the declared default', async () => {
    const fetchJson = vi.fn(async () => ({ items: [] }));
    const requirements: FrontendPageDataRequirement[] = [
      { as: 'tickets', fetch: { path: '/tickets?page=1&pageSize=50' } },
    ];

    await executePageData(requirements, options({ searchParams: { page: '2' }, fetchJson }));

    expect(fetchJson).toHaveBeenCalledWith('/tickets?page=2&pageSize=50');
  });

  it('drops the key (instead of failing the page) when the route param is missing', async () => {
    const fetchJson = vi.fn(async () => ({ id: 'leaked' }));
    const requirements: FrontendPageDataRequirement[] = [
      { as: 'ticket', fetch: { path: '/tickets/:id' } },
    ];

    const data = await executePageData(requirements, options({ fetchJson }));

    expect(fetchJson).not.toHaveBeenCalled();
    expect(data).toEqual({});
  });

  it('extracts a response field with select', async () => {
    const fetchJson = vi.fn(async () => ({ tickets: [{ id: 't-1' }], total: 1 }));
    const requirements: FrontendPageDataRequirement[] = [
      { as: 'tickets', fetch: { path: '/tickets?all=true', select: 'tickets' } },
    ];

    const data = await executePageData(requirements, options({ fetchJson }));

    expect(data).toEqual({ tickets: [{ id: 't-1' }] });
  });

  it('treats a select miss as "no data" instead of injecting undefined', async () => {
    const fetchJson = vi.fn(async () => ({ items: [] }));
    const requirements: FrontendPageDataRequirement[] = [
      { as: 'tickets', fetch: { path: '/tickets', select: 'tickets' } },
    ];

    const data = await executePageData(requirements, options({ fetchJson }));

    expect(data).toEqual({});
    expect(Object.keys(data)).not.toContain('tickets');
  });

  it('drops only the failing requirement and keeps its siblings', async () => {
    const fetchJson = vi.fn(async (path: string) => {
      if (path === '/boom') throw new Error('upstream 500');
      return { ok: true };
    });
    const requirements: FrontendPageDataRequirement[] = [
      { as: 'broken', fetch: { path: '/boom' } },
      { as: 'healthy', fetch: { path: '/fine' } },
    ];

    const data = await executePageData(requirements, options({ fetchJson }));

    expect(data).toEqual({ healthy: { ok: true } });
  });

  it('still enforces the declared permission before fetching', async () => {
    const fetchJson = vi.fn(async () => ({ secret: true }));
    const isAllowed = vi.fn(async () => false);
    const requirements: FrontendPageDataRequirement[] = [
      { as: 'secret', fetch: { path: '/admin/secret' }, permission: 'admin.secret' },
    ];

    const data = await executePageData(requirements, options({ fetchJson, isAllowed }));

    expect(isAllowed).toHaveBeenCalledWith('admin.secret');
    expect(fetchJson).not.toHaveBeenCalled();
    expect(data).toEqual({});
  });
});

describe('executePageData: finder requirements', () => {
  it('runs an admitted finder and reports success', async () => {
    const settled = vi.fn();
    const requirements: FrontendPageDataRequirement[] = [
      { as: 'mine', finder: 'ticket.myTickets' },
    ];

    const data = await executePageData(
      requirements,
      options({
        finders: {
          'ticket.myTickets': { handler: async () => ({ items: [1] }) },
        },
        onFinderSettled: settled,
      }),
    );

    expect(data).toEqual({ mine: { items: [1] } });
    expect(settled).toHaveBeenCalledWith('ticket.myTickets', true);
  });

  it('stays absent when the finder was not admitted', async () => {
    const requirements: FrontendPageDataRequirement[] = [
      { as: 'mine', finder: 'ticket.myTickets' },
    ];

    const data = await executePageData(requirements, options({ finders: {} }));

    expect(data).toEqual({});
  });

  it('reports a failing finder and drops just that key', async () => {
    const settled = vi.fn();
    const requirements: FrontendPageDataRequirement[] = [
      { as: 'mine', finder: 'ticket.myTickets' },
      { as: 'summary', finder: 'ticket.mySummary' },
    ];

    const data = await executePageData(
      requirements,
      options({
        finders: {
          'ticket.myTickets': {
            handler: async () => {
              throw new Error('boom');
            },
          },
          'ticket.mySummary': { handler: async () => ({ total: 1 }) },
        },
        onFinderSettled: settled,
      }),
    );

    expect(data).toEqual({ summary: { total: 1 } });
    expect(settled).toHaveBeenCalledWith('ticket.myTickets', false);
    expect(settled).toHaveBeenCalledWith('ticket.mySummary', true);
  });
});

describe('resolveFetchPath / resolveRequirementInput', () => {
  it('refuses to send a literal placeholder when a route param is missing', () => {
    expect(() => resolveFetchPath('/tickets/:id', {}, {})).toThrow(MissingRouteParamError);
    expect(() => resolveFetchPath('/tickets/:id', {}, {})).toThrow(/:id/);
  });

  it('prefers the first value of a repeated query key', () => {
    expect(resolveFetchPath('/tickets?page=1', {}, { page: ['3', '4'] }).query.page).toBe('3');
  });

  it('resolves :param and $query like finder input does', () => {
    expect(
      resolveRequirementInput({ input: { id: ':id', $query: {} } }, { id: 'abc' }, { page: '2' }),
    ).toEqual({ id: 'abc', $query: { page: '2' } });
  });
});
