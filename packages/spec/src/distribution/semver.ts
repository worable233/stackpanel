/**
 * 极简 SemVer 解析与范围判定（distribution 契约专用）。
 *
 * 为什么自带而不引 `semver`：`@stackpanel/spec` 的定位是**零运行时依赖**的契约单一
 * 来源（`src/index.ts`）。分发契约只需要判定「引用版本是否落在兼容范围」这一件事，
 * 不像 `apps/api` 那样需要完整 semver 语义，因此这里实现受控子集并正面钉死规则：
 *
 * - 支持：精确 `1.2.3`、前缀 `1` / `1.2` / `1.2.x`、`*`、比较符 `>= <= > < =`、
 *   脱字符 `^`、波浪号 `~`、空格分隔的 AND 组（不支持 `||` / hyphen 区间）。
 * - 预发布：按 SemVer 规则，只有**同一核心三元组**且带预发布标识的比较符才允许
 *   预发布版本命中；否则预发布一律不满足（避免 `1.2.3-beta` 意外匹配 `>=1.2.0`）。
 */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** 点分预发布标识；空数组表示无预发布。 */
  prerelease: string[];
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/;

/** 解析完整 SemVer；失败返回 null（构建元数据 `+…` 被忽略，不参与比较）。 */
export function parseSemver(input: string): Semver | null {
  const match = SEMVER_RE.exec(input.trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split('.') : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  // 有预发布 < 无预发布。
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const diff = Number(left) - Number(right);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

/** 标准 SemVer 比较：a < b 返回负、相等 0、a > b 返回正。 */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

type ComparatorOp = '>=' | '<=' | '>' | '<' | '=';

interface Comparator {
  op: ComparatorOp | '^' | '~';
  version: Semver;
}

function lowerBound(version: Semver): Semver {
  return { ...version, prerelease: [] };
}

function upperBound(op: '^' | '~', version: Semver): Semver {
  if (op === '~') {
    return { major: version.major, minor: version.minor + 1, patch: 0, prerelease: [] };
  }
  // ^：major>0 → 升 major；major=0,minor>0 → 升 minor；否则升 patch。
  if (version.major > 0) {
    return { major: version.major + 1, minor: 0, patch: 0, prerelease: [] };
  }
  if (version.minor > 0) {
    return { major: 0, minor: version.minor + 1, patch: 0, prerelease: [] };
  }
  return { major: 0, minor: 0, patch: version.patch + 1, prerelease: [] };
}

interface ParsedRange {
  wildcard: boolean;
  comparators: Comparator[];
  /** 允许预发布命中的核心三元组（比较符自身带预发布时）。 */
  prereleaseCores: Array<[number, number, number]>;
}

function parseToken(token: string): ParsedRange | null {
  if (token === '*' || token === '' || token === 'x' || token === 'X') {
    return { wildcard: true, comparators: [], prereleaseCores: [] };
  }
  const leading = /^(>=|<=|>|<|=|\^|~)/.exec(token);
  const op = (leading?.[1] ?? '') as ComparatorOp | '^' | '~' | '';
  const body = op ? token.slice(op.length) : token;
  // 先尝试完整 SemVer（`1.2.3`）：比较符 / ^ / ~ 都按完整版本处理。
  const parsed = parseSemver(body);
  if (parsed) {
    const prereleaseCores: Array<[number, number, number]> = parsed.prerelease.length
      ? [[parsed.major, parsed.minor, parsed.patch]]
      : [];
    if (op === '^' || op === '~') {
      return {
        wildcard: false,
        comparators: [
          { op: '>=', version: lowerBound(parsed) },
          { op: '<', version: upperBound(op, parsed) },
        ],
        prereleaseCores,
      };
    }
    if (op === '') {
      return { wildcard: false, comparators: [{ op: '=', version: parsed }], prereleaseCores };
    }
    return { wildcard: false, comparators: [{ op, version: parsed }], prereleaseCores };
  }
  // 前缀/通配：1 / 1.2 / 1.2.x 视为「最低边界 + 上界」。
  const partial = /^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(body);
  if (partial) {
    const major = Number(partial[1]);
    const minorRaw = partial[2];
    const patchRaw = partial[3];
    const minor = minorRaw === undefined || /[xX*]/.test(minorRaw) ? null : Number(minorRaw);
    const patch = patchRaw === undefined || /[xX*]/.test(patchRaw) ? null : Number(patchRaw);
    // 带比较符的 `>=1.2` 按最低边界处理；裸前缀按「区间」处理。
    if (op === '>' || op === '<' || op === '>=' || op === '<=' || op === '=') {
      const version = {
        major,
        minor: minor ?? 0,
        patch: patch ?? 0,
        prerelease: [],
      };
      return { wildcard: false, comparators: [{ op, version }], prereleaseCores: [] };
    }
    const low = { major, minor: minor ?? 0, patch: patch ?? 0, prerelease: [] };
    const comparators: Comparator[] = [{ op: '>=', version: low }];
    if (minor === null) {
      comparators.push({
        op: '<',
        version: { major: major + 1, minor: 0, patch: 0, prerelease: [] },
      });
    } else {
      comparators.push({
        op: '<',
        version: { major, minor: minor + 1, patch: 0, prerelease: [] },
      });
    }
    return { wildcard: false, comparators, prereleaseCores: [] };
  }
  return null;
}

function matchesComparator(version: Semver, comparator: Comparator): boolean {
  const diff = compareSemver(version, comparator.version);
  switch (comparator.op) {
    case '>=':
      return diff >= 0;
    case '<=':
      return diff <= 0;
    case '>':
      return diff > 0;
    case '<':
      return diff < 0;
    case '=':
      return diff === 0;
    default:
      return false;
  }
}

/**
 * 判断 `version` 是否满足 `range`。`range` 无效时返回 false（调用方应先用
 * {@link isVersionRange} 校验）。
 */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  if (!parsed) return false;
  const tokens = range.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const groups = tokens.map(parseToken);
  if (groups.some((group) => group === null)) return false;
  const allowPrerelease = (groups as ParsedRange[]).some((group) =>
    group.prereleaseCores.some(
      ([major, minor, patch]) =>
        major === parsed.major && minor === parsed.minor && patch === parsed.patch,
    ),
  );
  if (parsed.prerelease.length > 0 && !allowPrerelease) return false;
  return (groups as ParsedRange[]).every((group) => {
    if (group.wildcard) return true;
    return group.comparators.every((comparator) => matchesComparator(parsed, comparator));
  });
}

/** 范围字符串语法是否可被本实现解析（用于契约校验）。 */
export function isVersionRange(range: string): boolean {
  const tokens = range.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((token) => parseToken(token) !== null);
}

/** 从版本列表里挑出满足范围的最大版本（SemVer 比较）；无匹配返回 null。 */
export function maxSatisfying(versions: readonly string[], range: string): string | null {
  let best: Semver | null = null;
  let bestRaw: string | null = null;
  for (const raw of versions) {
    if (!satisfiesRange(raw, range)) continue;
    const parsed = parseSemver(raw);
    if (!parsed) continue;
    if (best === null || compareSemver(parsed, best) > 0) {
      best = parsed;
      bestRaw = raw;
    }
  }
  return bestRaw;
}
