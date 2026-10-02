/**
 * OpenAPI 契约投影 + 快照 + 兼容性判定（SPEC-SDK / D15）。
 *
 * 本模块是契约的**单一来源**：内核 `app.ts` 用它投影 `/api/v1` 文档，快照脚本
 * 与测试也用它。仓库此前「能生成 OpenAPI 却无变更检测」——一次删除路由、给写
 * 操作加必填参数、或把公开路由改成需要鉴权，都不会在合并前暴露。这里把规范投影
 * 成稳定的**契约语义**（路径 / 方法 / 鉴权 / 必填参数 / 请求体 / 响应码），CI 比对
 * 基线与当前，把破坏性变更变成红灯。
 *
 * 为什么是「投影」而不是整份规范：`/docs/json` 含大量与兼容性无关的生成细节
 * （summary、schema 展开），整份钉死会让任何文案改动都触发失败。{@link normalizeSpec}
 * 只保留契约语义。
 *
 * 判定规则（{@link diffContracts}）：
 * - 删除（路径或方法）→ 破坏。
 * - 新增 → 兼容（更新快照即可）。
 * - 鉴权由「无」变「有」/ 新增所需 scheme → 破坏；放宽 → 兼容。
 * - 新增**必填**参数 → 破坏；新增可选参数 → 兼容。
 * - 删除响应码 → 破坏；新增响应码 → 兼容。
 * - 新增请求体要求（原本没有、现在必填）→ 破坏。
 */

import { createHash } from 'node:crypto';

/** 单个操作的稳定契约投影。 */
export interface ContractOperation {
  /** 所需安全方案名（排序）；空 = 免鉴权。 */
  security: string[];
  /** 每个必填参数的 `${in}:${name}`（排序）。 */
  requiredParameters: string[];
  /** 该操作是否声明请求体。 */
  hasRequestBody: boolean;
  /** 已声明的响应码（排序）。 */
  responseCodes: string[];
}

/** 整个文档表面的可序列化快照。 */
export interface ContractSnapshot {
  /** 投影格式版本；{@link normalizeSpec} 形状变化时递增。 */
  formatVersion: number;
  /** 快照记录的开放平台版本（如 `v1`）。 */
  apiVersion: string;
  /** 操作表规范化后的 sha256；「是否有变动」的廉价信号。 */
  hash: string;
  /** 键格式：`${METHOD} ${path}`。 */
  operations: Record<string, ContractOperation>;
}

/** 检测到的单个破坏性变更。 */
export interface ContractBreak {
  kind:
    | 'operation_removed'
    | 'security_required_added'
    | 'security_scheme_added'
    | 'required_parameter_added'
    | 'request_body_added'
    | 'response_removed';
  method: string;
  path: string;
  detail: string;
}

export interface ContractDiff {
  breaking: ContractBreak[];
  added: string[];
  removed: string[];
}

interface RawOperation {
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{ name?: unknown; in?: unknown; required?: unknown }>;
  requestBody?: unknown;
  responses?: Record<string, unknown>;
}

interface RawSpec {
  paths?: Record<string, Record<string, RawOperation>>;
}

/** 从 OpenAPI `security` 数组提取安全方案名集合。 */
function securitySchemes(op: RawOperation): string[] {
  const schemes = new Set<string>();
  for (const requirement of op.security ?? []) {
    for (const scheme of Object.keys(requirement)) schemes.add(scheme);
  }
  return [...schemes].sort();
}

/**
 * 把原始 OpenAPI 文档投影成稳定、与兼容性相关的形状。路径与方法按排序访问，
 * 结果确定。
 */
export function normalizeSpec(spec: unknown): Record<string, ContractOperation> {
  const operations: Record<string, ContractOperation> = {};
  const paths = (spec as RawSpec)?.paths ?? {};
  for (const path of Object.keys(paths).sort()) {
    const pathItem = paths[path] ?? {};
    for (const method of Object.keys(pathItem).sort()) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;
      const requiredParameters = (op.parameters ?? [])
        .filter((parameter) => parameter?.required === true)
        .map((parameter) => `${String(parameter.in ?? '')}:${String(parameter.name ?? '')}`)
        .sort();
      operations[`${method.toUpperCase()} ${path}`] = {
        security: securitySchemes(op),
        requiredParameters,
        hasRequestBody: op.requestBody !== undefined && op.requestBody !== null,
        responseCodes: Object.keys(op.responses ?? {}).sort(),
      };
    }
  }
  return operations;
}

/** 把 `:param` 路由模板转成 OpenAPI `{param}` 形式。 */
export function toOpenApiPath(pathTemplate: string): string {
  return pathTemplate.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/**
 * 把投影限制到显式的 `METHOD /path` 键集合。契约快照限定在内核拥有的
 * `/api/v1` 能力项上，避免基线随环境里启用的插件漂移。
 */
export function scopeOperations(
  operations: Record<string, ContractOperation>,
  keys: Iterable<string>,
): Record<string, ContractOperation> {
  const allowed = new Set(keys);
  const scoped: Record<string, ContractOperation> = {};
  for (const key of Object.keys(operations).sort()) {
    if (allowed.has(key)) scoped[key] = operations[key] as ContractOperation;
  }
  return scoped;
}

/** 规范化 JSON：对象键排序、数组保序，保证 hash 稳定。 */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonicalize(val)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 对操作投影取稳定 sha256（与顺序无关）。 */
export function hashOperations(operations: Record<string, ContractOperation>): string {
  return createHash('sha256').update(canonicalize(operations)).digest('hex');
}

/** 从原始 OpenAPI 文档构建快照。 */
export function buildSnapshot(spec: unknown, apiVersion: string): ContractSnapshot {
  return snapshotFromOperations(normalizeSpec(spec), apiVersion);
}

/** 从已投影的操作表构建快照。 */
export function snapshotFromOperations(
  operations: Record<string, ContractOperation>,
  apiVersion: string,
): ContractSnapshot {
  return { formatVersion: 1, apiVersion, hash: hashOperations(operations), operations };
}

/** 比对基线快照与当前操作表。 */
export function diffContracts(
  baseline: ContractSnapshot,
  current: Record<string, ContractOperation>,
): ContractDiff {
  const breaking: ContractBreak[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const key of Object.keys(baseline.operations).sort()) {
    const base = baseline.operations[key];
    const next = current[key];
    if (!base) continue;
    const [method = '', ...pathParts] = key.split(' ');
    const path = pathParts.join(' ');
    if (!next) {
      removed.push(key);
      breaking.push({
        kind: 'operation_removed',
        method,
        path,
        detail: '接口被删除，调用方将收到 404',
      });
      continue;
    }

    if (base.security.length === 0 && next.security.length > 0) {
      breaking.push({
        kind: 'security_required_added',
        method,
        path,
        detail: `接口改为需要鉴权（${next.security.join(', ')}）`,
      });
    } else {
      const baselineSchemes = new Set(base.security);
      for (const scheme of next.security) {
        if (!baselineSchemes.has(scheme)) {
          breaking.push({
            kind: 'security_scheme_added',
            method,
            path,
            detail: `新增所需鉴权方式：${scheme}`,
          });
        }
      }
    }

    const baselineParams = new Set(base.requiredParameters);
    for (const parameter of next.requiredParameters) {
      if (!baselineParams.has(parameter)) {
        breaking.push({
          kind: 'required_parameter_added',
          method,
          path,
          detail: `新增必填参数：${parameter}`,
        });
      }
    }

    if (!base.hasRequestBody && next.hasRequestBody) {
      breaking.push({
        kind: 'request_body_added',
        method,
        path,
        detail: '接口改为要求请求体',
      });
    }

    const nextCodes = new Set(next.responseCodes);
    for (const code of base.responseCodes) {
      if (!nextCodes.has(code)) {
        breaking.push({
          kind: 'response_removed',
          method,
          path,
          detail: `移除响应码：${code}`,
        });
      }
    }
  }

  for (const key of Object.keys(current).sort()) {
    if (!baseline.operations[key]) added.push(key);
  }

  return { breaking, added, removed };
}
