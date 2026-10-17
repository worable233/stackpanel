/**
 * 宿主命令执行抽象（PLAN-github-distribution-and-updates §5.1、§5.4）。
 *
 * updater 是唯一持有 Docker socket 的进程；真实实现通过 `node:child_process`
 * 调用**镜像内预置**的 docker/compose/pg 客户端。为让状态机与适配器可单测，
 * 所有宿主调用都经本接口走，测试注入假实现即可覆盖成功/失败/超时分支而**不碰
 * 真实 Docker**。
 *
 * 安全约束（§5.1）：只允许白名单可执行文件；命令以参数数组形式传递（不经 shell），
 * 避免拼接注入；工作目录被限制在适配器给定的 project 目录内。
 */

import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';

/** 一次命令执行请求。 */
export interface CommandRequest {
  /** 可执行文件名（须在白名单内），如 `docker` / `docker-compose` / `pg_dump`。 */
  file: string;
  /** 参数数组（不经 shell）。 */
  args: string[];
  /** 工作目录（adapter 固定为绑定的 Compose project 目录）。 */
  cwd?: string;
  /** 附加环境变量（不覆盖父进程全部环境，仅合并）。 */
  env?: Record<string, string>;
  /** 超时毫秒；超时按失败处理（Docker 操作超时不等于失败——见 §5.2，调用方需复核现场）。 */
  timeoutMs?: number;
  /**
   * 允许非零退出码而不抛错（用于「预期失败」的探测命令）。
   * 缺省：非零退出码 → 抛 {@link CommandError}。
   */
  allowNonZeroExit?: boolean;
  /** 输入流（如 pg_restore 的 dump 内容）。与 `stdinFile` 互斥。 */
  stdin?: Uint8Array | string;
  /** 从该文件流式读取 stdin（二进制安全，如 pg_restore 的 dump）；与 `stdin` 互斥。 */
  stdinFile?: string;
  /**
   * 把子进程 stdout 直接流式写入该文件（二进制安全，如 pg_dump -Fc）。
   * 设置后 {@link CommandResult.stdout} 为空字符串。
   */
  stdoutFile?: string;
}

/** 命令执行结果。 */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly result: CommandResult,
    /** 是否因超时终止。 */
    readonly timedOut: boolean = false,
  ) {
    super(message);
  }
}

/** 宿主命令执行器契约；测试可注入记录/伪造结果的实现。 */
export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}

/**
 * 真实执行器：`spawn` 子进程，收集输出，施加超时。绝不使用 `shell: true`，
 * 因此参数中的任何字符都不会被解释为 shell 语法。
 */
export class SpawnCommandRunner implements CommandRunner {
  constructor(
    private readonly allowedFiles: readonly string[] = DEFAULT_ALLOWED_FILES,
    private readonly defaultTimeoutMs = 10 * 60_000,
  ) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    if (!this.allowedFiles.includes(request.file)) {
      throw new CommandError(`可执行文件不在白名单：${request.file}`, {
        code: -1,
        stdout: '',
        stderr: '',
      });
    }
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(request.file, request.args, {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, request.timeoutMs ?? this.defaultTimeoutMs);
      const sink = request.stdoutFile ? createWriteStream(request.stdoutFile) : null;
      child.stdout.on('data', (chunk: Buffer) => {
        if (sink) {
          sink.write(chunk);
        } else {
          stdout += chunk.toString('utf8');
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timeout);
        sink?.destroy();
        reject(
          new CommandError(`执行 ${request.file} 失败：${error.message}`, {
            code: -1,
            stdout,
            stderr,
          }),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        sink?.end();
        const result: CommandResult = { code: code ?? -1, stdout, stderr };
        if (timedOut) {
          reject(new CommandError(`${request.file} 超时`, result, true));
          return;
        }
        if (result.code !== 0 && !request.allowNonZeroExit) {
          reject(new CommandError(`${request.file} 退出码 ${result.code}`, result));
          return;
        }
        resolve(result);
      });
      if (request.stdinFile !== undefined) {
        createReadStream(request.stdinFile).pipe(child.stdin);
      } else if (request.stdin !== undefined) {
        child.stdin.end(request.stdin);
      } else {
        child.stdin.end();
      }
    });
  }
}

/** 预置客户端白名单（§5.1：镜像固定内置、不由包内内容决定）。 */
export const DEFAULT_ALLOWED_FILES: readonly string[] = Object.freeze([
  'docker',
  'docker-compose',
  'pg_dump',
  'pg_restore',
  'psql',
  'tar',
  'gzip',
  'du',
  'df',
]);
