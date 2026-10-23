/**
 * 引导配置文件的唯一读写实现（审计 R7）。
 *
 * 为什么**只能有一份**实现：systemd `EnvironmentFile`、`dotenv` 与 shell 的
 * 语法并不相同。三处各写一个"简单解析"必然产生分歧：密码里的 `#` 被当注释、
 * 引号被吞掉、`\n` 被解释成换行。这里冻结一个**共同子集**，并保证往返无损：
 *
 * - 每行 `KEY=VALUE`（可带前导空白；支持 `export ` 前缀）；
 * - `#` 开头为整行注释，**行内 `#` 是值的一部分**（不做行内注释剥离）；
 * - 值可整体用单引号或双引号包裹；去引号后**原样保留**内容，
 *   不做 `\n` / `\t` 等转义解释（systemd 与 dotenv 在此行为不同，
 *   解释转义正是分歧来源）；
 * - 未加引号的值等价于"到行尾为止"，但**首尾空白去除**；
 * - 换行与回车（`\r` / `\n`）出现在值中一律**拒绝**，不做规范化；
 * - 空行与纯空白行忽略。
 *
 * 写入端与读取端共用 {@link serializeBootstrapFile} / {@link parseBootstrapFile}，
 * 因此任何值只要通过 {@link assertSafeValue} 就能原样读回。
 */

import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/** 引导配置文件格式版本（与 spec 的 `BOOTSTRAP_CONFIG_FORMAT_VERSION` 对齐）。 */
export const BOOTSTRAP_FILE_FORMAT_VERSION = 1;

/** 值中不可出现的字符：换行与回车。 */
const FORBIDDEN_IN_VALUE = /[\r\n]/;

/** 键名必须匹配 POSIX 环境变量名，避免解析器与 shell 交互时产生歧义。 */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class BootstrapFileError extends Error {
  constructor(
    message: string,
    /** 机器可读的分类，供 API 映射为稳定错误码。 */
    readonly code:
      | 'invalid_line'
      | 'invalid_key'
      | 'invalid_value'
      | 'duplicate_key'
      | 'too_large' = 'invalid_value',
  ) {
    super(message);
    this.name = 'BootstrapFileError';
  }
}

/**
 * 校验一个值能否被无损序列化。
 *
 * 拒绝项：换行/回车（会伪造出新的一行）、NUL（会截断 C 字符串）。
 * 其它字符（含 `#`、引号、反斜杠、空格、`$`、`=`）全部允许，因为序列化时
 * 会整体加引号且不解释转义。
 */
export function assertSafeValue(key: string, value: string, maxLength = 8192): void {
  if (!KEY_PATTERN.test(key)) {
    throw new BootstrapFileError(`非法键名：${key}`, 'invalid_key');
  }
  if (value.includes('\0') || FORBIDDEN_IN_VALUE.test(value)) {
    throw new BootstrapFileError(`配置值包含换行或 NUL 字符：${key}`, 'invalid_value');
  }
  if (value.length > maxLength) {
    throw new BootstrapFileError(`配置值过长（${value.length} > ${maxLength}）：${key}`, 'too_large');
  }
}

/**
 * 解析配置文件内容。
 *
 * 返回保留插入顺序的键值对。重复键**报错**而不是后者覆盖前者：
 * 静默覆盖会让"配置文件里有 3 个 DATABASE_URL"这种事故无法被发现。
 */
export function parseBootstrapFile(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = content.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? '';
    const lineNumber = index + 1;
    // 只去掉行尾的 `\r`（CRLF 文件）；值内部的 `\r` 已被 assertSafeValue 拒绝。
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const separator = withoutExport.indexOf('=');
    if (separator <= 0) {
      throw new BootstrapFileError(`第 ${lineNumber} 行不是 KEY=VALUE`, 'invalid_line');
    }

    const key = withoutExport.slice(0, separator).trim();
    if (!KEY_PATTERN.test(key)) {
      throw new BootstrapFileError(`第 ${lineNumber} 行键名非法：${key}`, 'invalid_key');
    }

    let value = withoutExport.slice(separator + 1);
    // 未加引号时去首尾空白；加引号时按引号内容原样保留。
    const leading = value.trimStart();
    if (leading.startsWith('"')) {
      const end = leading.lastIndexOf('"');
      if (end <= 0) {
        throw new BootstrapFileError(`第 ${lineNumber} 行双引号未闭合`, 'invalid_line');
      }
      value = leading.slice(1, end);
      const trailing = leading.slice(end + 1).trim();
      if (trailing.length > 0 && !trailing.startsWith('#')) {
        throw new BootstrapFileError(`第 ${lineNumber} 行引号后有多余内容`, 'invalid_line');
      }
    } else if (leading.startsWith("'")) {
      const end = leading.lastIndexOf("'");
      if (end <= 0) {
        throw new BootstrapFileError(`第 ${lineNumber} 行单引号未闭合`, 'invalid_line');
      }
      value = leading.slice(1, end);
      const trailing = leading.slice(end + 1).trim();
      if (trailing.length > 0 && !trailing.startsWith('#')) {
        throw new BootstrapFileError(`第 ${lineNumber} 行引号后有多余内容`, 'invalid_line');
      }
    } else {
      value = leading.trimEnd();
    }

    if (result.has(key)) {
      throw new BootstrapFileError(`第 ${lineNumber} 行重复的键：${key}`, 'duplicate_key');
    }
    result.set(key, value);
  }

  return result;
}

/**
 * 序列化整份配置。
 *
 * 始终使用**双引号**包裹值：`#`、空格、`$`、`=`、单引号都不会被误解释，
 * 且 systemd 与 dotenv 对"双引号内不解释转义"的行为一致。
 * 唯一例外是值本身含双引号 —— 这时改用单引号（systemd 与 dotenv 同样
 * 不在单引号内解释转义）。两者都含时无法无损表达，直接拒绝。
 */
export function serializeBootstrapFile(entries: Iterable<[string, string]>): string {
  const lines: string[] = [];
  for (const [key, value] of entries) {
    assertSafeValue(key, value);
    if (!value.includes('"')) {
      lines.push(`${key}="${value}"`);
    } else if (!value.includes("'")) {
      lines.push(`${key}='${value}'`);
    } else {
      throw new BootstrapFileError(
        `配置值同时包含单引号与双引号，无法无损序列化：${key}`,
        'invalid_value',
      );
    }
  }
  // 末尾保留一个换行，符合 POSIX 文本文件约定，也便于人工追加。
  return `${lines.join('\n')}\n`;
}

/** 稳定的内容摘要；用于识别"同一份配置"（幂等键比较）。 */
export function bootstrapConfigDigest(entries: Iterable<[string, string]>): string {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash('sha256');
  for (const [key, value] of sorted) {
    hash.update(`${key}\0${value}\0`);
  }
  return hash.digest('hex');
}

/** 原子写：临时文件 + fsync + rename + fsync 父目录（审计 R3）。 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  options: { mode?: number; uid?: number; gid?: number } = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);

  const handle = await open(tempPath, 'wx', options.mode ?? 0o640);
  try {
    await handle.writeFile(content, 'utf8');
    // fsync 文件内容，否则断电后 rename 可能指向空文件（ext4 等）。
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    if (options.uid !== undefined && options.gid !== undefined) {
      const { chown } = await import('node:fs/promises');
      await chown(tempPath, options.uid, options.gid);
    }
    if (options.mode !== undefined) await chmod(tempPath, options.mode);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }

  // rename 只保证目录项替换的原子性；要让它在掉电后仍可见，必须同步目录本身。
  const dirHandle = await open(dir, 'r');
  try {
    await dirHandle.sync();
  } catch {
    // 某些文件系统（如部分网络盘）不支持目录 fsync；不因此判定写失败。
  } finally {
    await dirHandle.close();
  }
}

/** 读取配置文件；文件不存在返回 null（= 未配置）。 */
export async function readBootstrapFile(filePath: string): Promise<Map<string, string> | null> {
  try {
    const content = await readFile(filePath, 'utf8');
    return parseBootstrapFile(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** 文件是否存在且可读。 */
export async function bootstrapFileExists(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}
