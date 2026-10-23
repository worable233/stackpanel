/**
 * 诊断信息的脱敏（审计 R8）。
 *
 * 自举阶段唯一可能包含敏感信息的地方是**错误文本**：Prisma 的连接错误会带上
 * `postgresql://user:password@host/db`，S3 SDK 会带上 access key，运维粘贴的
 * 日志里还可能有初始化令牌。诊断接口只在持有令牌时可读，但「持有令牌」不等于
 * 「可以把它变成凭据泄漏的副本」，因此输出前统一过一遍本模块。
 *
 * 设计原则：
 * - **白名单式的替换，不是黑名单式的过滤**：只保留结构，把"看起来像凭据"的
 *   片段整段换成占位符；
 * - 幂等：脱敏后的文本再次脱敏不应继续变化；
 * - 有长度上限：避免把整个堆栈或二进制垃圾回显给浏览器。
 */

/** 回显的最大长度；超出部分截断并显式标记。 */
export const MAX_DIAGNOSTIC_LENGTH = 4_000;

const PLACEHOLDER = '<redacted>';

/**
 * 带内嵌凭据的 URL：`scheme://user:pass@host` → `scheme://<redacted>@host`。
 *
 * 用户名可以为空（`redis://:password@host` 是合法且常见的写法），因此
 * 冒号左侧用 `*` 而不是 `+`：漏掉这一种等于把密码原样回显。
 */
const URL_WITH_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*:[^\s/@]*@/gi;

/** 形如 `user:password@host` 但协议无法识别的连接串。 */
const BARE_CREDENTIALS = /\b([A-Za-z0-9_.-]+):([^\s/@:]+)@([A-Za-z0-9_.:-]+)/g;

/** 常见凭据键值对（`password=…`、`accessKeyId: …`、`token: …`）。 */
const KEY_VALUE_SECRET = /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|authorization|cookie)\b(\s*[:=]\s*)("([^"]*)"|'([^']*)'|[^\s,;]+)/gi;

/** 足够像密钥的长串（hex/base64url）；保留前 4 位便于比对日志。 */
const LONG_SECRET = /\b([A-Fa-f0-9]{40,}|[A-Za-z0-9_-]{48,})\b/g;

/**
 * 脱敏一段诊断文本。
 *
 * 注意顺序：先处理 URL（它同时含 `user:pass@` 与协议），再处理裸露的
 * `user:pass@host`，最后才处理通用键值对与长串。
 */
export function redactDiagnosticText(input: string, maxLength = MAX_DIAGNOSTIC_LENGTH): string {
  let text = input;
  text = text.replace(URL_WITH_CREDENTIALS, `$1${PLACEHOLDER}@`);
  text = text.replace(BARE_CREDENTIALS, `$1:${PLACEHOLDER}@$3`);
  text = text.replace(KEY_VALUE_SECRET, (_match, key: string, separator: string) => {
    return `${key}${separator}${PLACEHOLDER}`;
  });
  text = text.replace(LONG_SECRET, (match) => `${match.slice(0, 4)}…${PLACEHOLDER}`);
  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength)}\n…（已截断，共 ${input.length} 字符）`;
  }
  return text;
}

/** 对任意结构里的字符串递归脱敏；数组/对象保持形状。 */
export function redactDiagnosticValue<T>(value: T, maxLength = MAX_DIAGNOSTIC_LENGTH): T {
  if (typeof value === 'string') return redactDiagnosticText(value, maxLength) as T;
  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticValue(item, maxLength)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactDiagnosticValue(item, maxLength);
    }
    return output as T;
  }
  return value;
}
