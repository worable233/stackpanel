import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 把镜像引用**落盘**写进 compose 的 env 文件（P0-A）。
 *
 * ## 为什么必须落盘
 *
 * `switchTo` 只用进程环境覆盖 `STACKPANEL_IMAGE` 去跑 `compose up -d`：容器确实换
 * 成了新 digest，但 `.env` 里仍是旧 tag。于是：
 *
 * - 运维/脚本执行 `docker compose up -d`（没有 env 覆盖）→ api/worker/web 全部
 *   **静默回退到旧版本**，而数据库已经被新版本迁移过，形成版本倒挂；
 * - `docker compose config` 显示的声明值仍是旧镜像，与容器实际运行的不一致；
 * - updater 的部署指针（generation/digest）指向新的，更新中心却按指针判定
 *   「已是最新」—— 权威状态与实际运行状态永久错位。
 *
 * ## 为什么是「原子回写」
 *
 * `.env` 里同时存着 POSTGRES_PASSWORD / JWT_SECRET 等密钥。写到一半崩溃会留下
 * 被截断的文件，下一次 `compose up` 就会用空密码重建数据库。所以先写同目录的
 * 临时文件、`fsync` 后 `rename` 覆盖 —— rename 在同一文件系统内是原子的，
 * 读到的要么是旧内容要么是新内容，不存在半截。
 *
 * 保留原文件的权限：`.env` 往往是 `600`/`640`，新建的临时文件默认 `644`，
 * 直接 rename 会把权限放大成全局可读。
 */

export interface EnvRewrite {
  /** 变量名 → 新的字面值（不含引号）。 */
  [name: string]: string;
}

/**
 * 原子地把若干变量写进 env 文件，返回最终写下的内容。
 *
 * 已存在的键就地替换（保留其位置与注释顺序）；不存在的键追加到末尾。
 * 只处理 `KEY=value` 形式的行 —— 被注释掉的行（`# KEY=...`）原样保留，
 * 因为运维常把旧值注释留档，覆盖它会丢信息。
 */
export async function rewriteEnvFile(file: string, values: EnvRewrite): Promise<string> {
  const original = await readFile(file, 'utf8');
  const pending = new Map(Object.entries(values));
  const lines = original.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!match) {
      out.push(line);
      continue;
    }
    const key = match[1];
    const next = key === undefined ? undefined : pending.get(key);
    if (key === undefined || next === undefined) {
      out.push(line);
      continue;
    }
    out.push(`${key}=${next}`);
    pending.delete(key);
  }
  // 文件末尾可能没有换行：split 会得到最后一个 `''`，追加前先去掉它。
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  for (const [key, value] of pending) out.push(`${key}=${value}`);
  const next = `${out.join('\n')}\n`;

  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  // 先读原文件权限再写临时文件：`.env` 通常是 600/640，默认 644 会放大权限。
  const { stat } = await import('node:fs/promises');
  const mode = await stat(file)
    .then((s) => s.mode & 0o777)
    .catch(() => 0o600);
  await writeFile(temp, next, { encoding: 'utf8', mode });
  await rename(temp, file);
  return next;
}

/**
 * 读 env 文件里某个变量的**字面值**（不做插值）。
 *
 * 只用于校验「声明值是否等于目标 digest」。找不到返回 undefined；
 * 变量存在但为空串时返回 `''`（这与「没有该变量」是两回事）。
 */
export async function readEnvValue(file: string, name: string): Promise<string | undefined> {
  const text = await readFile(file, 'utf8');
  for (const line of text.split('\n')) {
    const match = new RegExp(`^${name}=(.*)$`).exec(line);
    const value = match?.[1];
    if (value !== undefined) return value.trim();
  }
  return undefined;
}
