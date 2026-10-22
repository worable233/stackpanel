/**
 * 引导配置文件的读写（runner 侧）。
 *
 * 与内核 `apps/api/src/bootstrap/config-file.ts` **必须是同一份语义**：
 * runner 与 API 交替读写同一个文件，任何解析分歧都会产生"API 写进去、
 * runner 读出来变了"的事故（审计 R7）。
 *
 * 为什么不共享一个包：updater 是独立发布的可执行体，不能依赖内核源码树。
 * 因此这里刻意逐行镜像同一实现，并由
 * `apps/updater/tests/bootstrap-file-parity.test.ts` 用共享用例钉住两边的
 * 行为一致；改动任一侧都会让该测试失败。
 */

import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const FORBIDDEN_IN_VALUE = /[\r\n]/;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class BootstrapFileError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_line' | 'invalid_key' | 'invalid_value' | 'duplicate_key' | 'too_large' =
      'invalid_value',
  ) {
    super(message);
    this.name = 'BootstrapFileError';
  }
}

/** 校验值可无损序列化（拒绝换行、回车、NUL 与超长）。 */
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

/** 解析配置文件；重复键报错，不静默覆盖。 */
export function parseBootstrapFile(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = content.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? '';
    const lineNumber = index + 1;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const withoutExport = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trim()
      : trimmed;
    const separator = withoutExport.indexOf('=');
    if (separator <= 0) {
      throw new BootstrapFileError(`第 ${lineNumber} 行不是 KEY=VALUE`, 'invalid_line');
    }

    const key = withoutExport.slice(0, separator).trim();
    if (!KEY_PATTERN.test(key)) {
      throw new BootstrapFileError(`第 ${lineNumber} 行键名非法：${key}`, 'invalid_key');
    }

    let value = withoutExport.slice(separator + 1);
    const leading = value.trimStart();
    if (leading.startsWith('"')) {
      const end = leading.lastIndexOf('"');
      if (end <= 0) throw new BootstrapFileError(`第 ${lineNumber} 行双引号未闭合`, 'invalid_line');
      value = leading.slice(1, end);
      const trailing = leading.slice(end + 1).trim();
      if (trailing.length > 0 && !trailing.startsWith('#')) {
        throw new BootstrapFileError(`第 ${lineNumber} 行引号后有多余内容`, 'invalid_line');
      }
    } else if (leading.startsWith("'")) {
      const end = leading.lastIndexOf("'");
      if (end <= 0) throw new BootstrapFileError(`第 ${lineNumber} 行单引号未闭合`, 'invalid_line');
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

/** 序列化；值始终加引号且不解释转义，保证往返无损。 */
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
  return `${lines.join('\n')}\n`;
}

/** 原子写：临时文件 + fsync + rename + 目录 fsync。 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  options: { mode?: number } = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);

  const handle = await open(tempPath, 'wx', options.mode ?? 0o640);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    if (options.mode !== undefined) await chmod(tempPath, options.mode);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }

  const dirHandle = await open(dir, 'r');
  try {
    await dirHandle.sync();
  } catch {
    // 部分文件系统不支持目录 fsync；不据此判定失败。
  } finally {
    await dirHandle.close();
  }
}
