/**
 * 部署指针（PLAN-github-distribution-and-updates §5.2、§5.4-6）。
 *
 * 记录「当前实际部署的镜像 digest 与 generation」，放在 updater 独立卷上，重启后
 * 据此对账。它**不**替代 Docker 现场：Docker 操作超时不等于失败（§5.2），恢复时
 * 需以本指针 + 实际容器状态共同判断。切换成功后 generation 递增，供下一次
 * preflight 校验「基线未变」。
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface DeploymentPointer {
  /** 部署代次；每次成功切换递增。 */
  generation: number;
  /** 当前生效的完整镜像引用（`repo@sha256:...`）。 */
  digest: string;
  /** 上一条引用，供回退。 */
  previousDigest: string | null;
  /** 上一代 generation。 */
  previousGeneration: number | null;
  updatedAt: string;
}

export class FileDeploymentPointer {
  constructor(private readonly filePath: string) {}

  async read(): Promise<DeploymentPointer | null> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as DeploymentPointer;
      return typeof parsed.generation === 'number' && typeof parsed.digest === 'string'
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  /** 原子写：临时文件 + rename，避免读到半写内容。 */
  async write(pointer: DeploymentPointer): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(pointer, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }

  /** 切换到新 digest，generation 递增并保留上一代。 */
  async advance(input: { digest: string; now: Date }): Promise<DeploymentPointer> {
    const current = await this.read();
    const next: DeploymentPointer = {
      generation: (current?.generation ?? 0) + 1,
      digest: input.digest,
      previousDigest: current?.digest ?? null,
      previousGeneration: current?.generation ?? null,
      updatedAt: input.now.toISOString(),
    };
    await this.write(next);
    return next;
  }

  static resolve(stateDir: string): FileDeploymentPointer {
    return new FileDeploymentPointer(path.join(stateDir, 'deployment-pointer.json'));
  }
}
