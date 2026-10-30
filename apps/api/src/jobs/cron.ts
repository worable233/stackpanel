/**
 * Minimal 5-field cron parser for the in-process job backend (ADR-0013).
 *
 * Why this exists: `{ cron }` schedules used to be dropped without Redis, which
 * silently disabled scheduled work in single-node/dev deployments (audit E-10).
 * Redis is only needed to *coordinate* replicas — a single process can arm its
 * own timer. BullMQ still owns cron in a real cluster; this parser is the
 * fallback path only, so it deliberately supports the common syntax and rejects
 * everything else instead of guessing:
 *
 * - `*` — every value
 * - `N` — one value
 * - `a-b` — inclusive range
 * - `*​/s`, `a-b/s`, `a/s` — every `s`-th value
 * - comma lists of any of the above
 *
 * Standard cron semantics for day-of-month/day-of-week: when *both* are
 * restricted a match on either is enough; when only one is restricted it must
 * match. Day-of-week accepts 0-7 (0 and 7 are Sunday).
 */

/** Thrown when an expression cannot be understood. Never guessed around. */
export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronParseError';
  }
}

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** Whether the source field was `*` (used for the dom/dow OR rule). */
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
  /** The original text, kept for logs and diagnostics. */
  expression: string;
}

interface FieldSpec {
  min: number;
  max: number;
  name: string;
  /** Normalise a raw value (day-of-week maps 7 -> 0). */
  normalize?: (value: number) => number;
}

function parseField(raw: string, spec: FieldSpec): { values: Set<number>; restricted: boolean } {
  const text = raw.trim();
  if (text === '') throw new CronParseError(`cron ${spec.name} 字段为空`);
  const values = new Set<number>();
  const normalize = spec.normalize ?? ((value: number) => value);

  for (const part of text.split(',')) {
    const piece = part.trim();
    if (piece === '') throw new CronParseError(`cron ${spec.name} 字段含空项`);
    if (piece === '*') {
      for (let value = spec.min; value <= spec.max; value += 1) values.add(normalize(value));
      continue;
    }
    const [rangeText, stepText, ...rest] = piece.split('/');
    if (rest.length > 0) throw new CronParseError(`cron ${spec.name} 字段无法解析：${piece}`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step <= 0)
      throw new CronParseError(`cron ${spec.name} 步长非法：${piece}`);

    let start: number;
    let end: number;
    if (rangeText === '*') {
      start = spec.min;
      end = spec.max;
    } else if (rangeText !== undefined && rangeText.includes('-')) {
      const bounds = rangeText.split('-');
      if (bounds.length !== 2) throw new CronParseError(`cron ${spec.name} 范围非法：${piece}`);
      start = Number(bounds[0]);
      end = Number(bounds[1]);
    } else {
      start = Number(rangeText);
      // `a/s` means "from a to the field maximum, every s".
      end = stepText === undefined ? start : spec.max;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end))
      throw new CronParseError(`cron ${spec.name} 取值非法：${piece}`);
    if (start < spec.min || end > spec.max || start > end)
      throw new CronParseError(
        `cron ${spec.name} 超出范围 ${spec.min}-${spec.max}：${piece}`,
      );
    for (let value = start; value <= end; value += step) values.add(normalize(value));
  }

  if (values.size === 0) throw new CronParseError(`cron ${spec.name} 未产生任何取值`);
  return { values, restricted: text !== '*' };
}

/** Parse a 5-field expression: `minute hour day-of-month month day-of-week`. */
export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5)
    throw new CronParseError(
      `cron 需要 5 个字段（分 时 日 月 周），收到 ${fields.length} 个：${expression}`,
    );
  const minutes = parseField(fields[0]!, { min: 0, max: 59, name: '分钟' });
  const hours = parseField(fields[1]!, { min: 0, max: 23, name: '小时' });
  const daysOfMonth = parseField(fields[2]!, { min: 1, max: 31, name: '日' });
  const months = parseField(fields[3]!, { min: 1, max: 12, name: '月' });
  const daysOfWeek = parseField(fields[4]!, {
    min: 0,
    max: 7,
    name: '星期',
    normalize: (value) => (value === 7 ? 0 : value),
  });

  return {
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: daysOfMonth.values,
    months: months.values,
    daysOfWeek: daysOfWeek.values,
    dayOfMonthRestricted: daysOfMonth.restricted,
    dayOfWeekRestricted: daysOfWeek.restricted,
    expression,
  };
}

/** Whether `date` (in UTC) satisfies the parsed expression. */
export function matchesCron(cron: ParsedCron, date: Date): boolean {
  if (!cron.minutes.has(date.getUTCMinutes())) return false;
  if (!cron.hours.has(date.getUTCHours())) return false;
  if (!cron.months.has(date.getUTCMonth() + 1)) return false;
  const dayOfMonth = cron.daysOfMonth.has(date.getUTCDate());
  const dayOfWeek = cron.daysOfWeek.has(date.getUTCDay());
  if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) return dayOfMonth || dayOfWeek;
  if (cron.dayOfMonthRestricted) return dayOfMonth;
  if (cron.dayOfWeekRestricted) return dayOfWeek;
  return true;
}

/** How far ahead to look before declaring the expression unreachable. */
const SEARCH_WINDOW_MINUTES = 366 * 24 * 60;

/**
 * The first UTC minute strictly after `fromMs` that matches, in epoch ms.
 *
 * Cron resolution is one minute, so the search starts at the next minute
 * boundary. Throws {@link CronParseError} when nothing matches within a year
 * (e.g. `0 0 30 2 *`), which is always a misconfiguration rather than a wait.
 */
export function nextCronFireMs(expression: string, fromMs: number): number {
  const cron = parseCron(expression);
  const start = new Date(fromMs);
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);
  for (let step = 0; step < SEARCH_WINDOW_MINUTES; step += 1) {
    const candidate = new Date(start.getTime() + step * 60_000);
    if (matchesCron(cron, candidate)) return candidate.getTime();
  }
  throw new CronParseError(`cron 一年内不会触发，请检查表达式：${expression}`);
}
