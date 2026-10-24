import 'server-only';

/**
 * 页面声明式数据需求（`FrontendPageDataRequirement`）的统一求值器。
 *
 * 账户页（M1 服务端渲染）与后台页（M2）原本各有一份几乎相同的 `executeRouteData`
 * ——两份都在做「判权限 → 找 finder → 调 handler → 失败返回 null」，于是任何一条
 * 规则（新增取数形式、权限语义、容错策略）都要改两遍，且容易改漏一处。
 *
 * 这里同时承载**信任边界**：`fetch` 形式由宿主自己发请求，不执行插件代码，因此不受
 * `candidateAdmitsServerExecution` 门禁约束；`finder` 形式执行包内代码，调用方必须先
 * 通过门禁才会传进来（见 `admin-frontend.ts` / `account-frontend.ts`）。
 */

import type {
  ApiClient,
  FinderContext,
  FinderProvider,
  FinderSession,
  FrontendPageDataRequirement,
  FrontendSettings,
} from '@stackpanel/sdk';
import { z } from 'zod';

/**
 * 把声明里的占位符解析成实际值。
 *
 * 支持三种写法，与 finder 的 `input` 语义保持一致：
 * - `':id'` 取路由参数
 * - `'$query'` 取整个查询串（以对象形式）
 * - 其它字符串取同名的查询参数，缺省则用字面量
 */
export function resolveRequirementInput(
  requirement: Pick<FrontendPageDataRequirement, 'input'>,
  params: Record<string, string>,
  searchParams: QueryParams,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(requirement.input ?? {}).map(([key, value]) => [
      key,
      key === '$query'
        ? searchParams
        : typeof value === 'string' && value.startsWith(':')
          ? (params[value.slice(1)] ?? value)
          : (firstValue(searchParams[key]) ?? value),
    ]),
  );
}

/**
 * Query values arrive as `string` from the account/admin resolvers and as
 * `string | string[]` from the RSC page resolver (repeated keys). Accept both so
 * one evaluator serves all three call sites.
 */
export type QueryParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * 解析声明式 `fetch.path` 里的占位符。
 *
 * `:param` 来自路由参数，`?query` 里的值同样按查询串替换。路径是普通的
 * `path-to-regexp` 风格片段（`/tickets/:id`），因此只做字符串替换，不再解析路径本身。
 */
export function resolveFetchPath(
  path: string,
  params: Record<string, string>,
  searchParams: QueryParams,
): { path: string; query: Record<string, string> } {
  const [rawPath = '', rawQuery = ''] = path.split('?');
  const resolvedPath = rawPath.replace(/:([A-Za-z0-9_]+)/g, (whole, name: string) => {
    const value = params[name];
    // 参数缺失时保留占位符会让请求打到字面量 `:id`，比直接失败更难排查。
    // 交给调用方按「无数据」处理更诚实。
    if (value === undefined || value === '') throw new MissingRouteParamError(name, whole);
    return encodeURIComponent(value);
  });
  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(rawQuery)) {
    query[key] = value.startsWith(':')
      ? (params[value.slice(1)] ?? '')
      : (firstValue(searchParams[key]) ?? value);
  }
  return { path: resolvedPath, query };
}

/** 声明里引用了路由参数，但当前路由没有这个参数。 */
export class MissingRouteParamError extends Error {
  constructor(
    readonly param: string,
    readonly placeholder: string,
  ) {
    super(`数据需求引用了不存在的路由参数 ${placeholder}`);
    this.name = 'MissingRouteParamError';
  }
}

type FetchRunner = (path: string) => Promise<unknown>;

/**
 * 从响应里取出 `select` 指定的子值。
 *
 * 只支持点路径（`tickets`、`data.items`），不做表达式求值——宿主不该为了取一个
 * 字段而变成一个小型查询引擎。路径不存在时返回 `undefined`，调用方按「无数据」
 * 处理（与整条需求失败一致）。
 */
function selectFromResponse(value: unknown, select: string | undefined): unknown {
  if (!select) return value;
  let current = value;
  for (const key of select.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * 默认的声明式取数实现：走内核 API 客户端。
 *
 * 用 `z.unknown()` 是因为数据形状由插件前端自己解释（`props.data` 本来就是
 * `Record<string, unknown>`）。若在这里对未知查询参数强加 schema，等于让宿主
 * 替插件决定数据契约。
 */
function kernelFetchRunner(api: ApiClient): FetchRunner {
  return async (path) => api.get<unknown>(path, z.unknown());
}

/**
 * 依据声明求值一页数据。
 *
 * 失败语义：单条需求失败**不影响**其它需求，该键直接从结果里缺席——页面据此渲染
 * 「暂无数据」。整页 500 会让「某个小部件没权限」变成「整页打不开」。
 */
export async function executePageData(
  requirements: readonly FrontendPageDataRequirement[],
  options: {
    /** 准入后的 finder 集合；未获准入时传空对象，`finder` 需求自然缺席。 */
    finders?: Record<string, FinderProvider>;
    params: Record<string, string>;
    searchParams?: QueryParams;
    settings: FrontendSettings;
    /** `null` when the request is anonymous (public theme pages). */
    session: FinderSession | null;
    /**
     * Observation hook, called once per `finder` requirement. The RSC page
     * resolver uses it to audit which plugin supplied data and whether it
     * succeeded; the account/admin resolvers pass nothing.
     */
    onFinderSettled?: (finderId: string, ok: boolean) => void;
    /** 复用同一个客户端，避免每页重复建连。 */
    api: ApiClient;
    isAllowed: (permission: string) => Promise<boolean>;
    /** 测试注入点；默认走内核 API 客户端。 */
    fetchJson?: FetchRunner;
  },
): Promise<Record<string, unknown>> {
  const searchParams = options.searchParams ?? {};
  const fetchJson = options.fetchJson ?? kernelFetchRunner(options.api);
  const values = await Promise.all(
    requirements.map(async (requirement): Promise<readonly [string, unknown] | null> => {
      if (requirement.permission && !(await options.isAllowed(requirement.permission))) return null;
      try {
        if (requirement.fetch) {
          const { path, query } = resolveFetchPath(
            requirement.fetch.path,
            options.params,
            searchParams,
          );
          const search = new URLSearchParams(query).toString();
          const response = await fetchJson(search ? `${path}?${search}` : path);
          const value = selectFromResponse(response, requirement.fetch.select);
          // `select` 落空时整条需求缺席，而不是把 `undefined` 塞进 props：
          // 页面拿到的要么是数据，要么是没有这个键。
          if (value === undefined) return null;
          return [requirement.as, value] as const;
        }
        if (requirement.finder) {
          const finderId = requirement.finder;
          const finder = options.finders?.[finderId];
          // 未获准入（或包内没有这个 finder）时静默缺席：门禁本身是策略，不是错误。
          if (!finder) return null;
          const input = resolveRequirementInput(requirement, options.params, searchParams);
          const context: FinderContext = {
            params: options.params,
            settings: options.settings,
            api: options.api,
            session: options.session,
          };
          try {
            const value = await finder.handler(input, context);
            options.onFinderSettled?.(finderId, true);
            return [requirement.as, value] as const;
          } catch (error) {
            options.onFinderSettled?.(finderId, false);
            throw error;
          }
        }
        return null;
      } catch {
        return null;
      }
    }),
  );
  return Object.fromEntries(
    values.filter((value): value is readonly [string, unknown] => value !== null),
  );
}
