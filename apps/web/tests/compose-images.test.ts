import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * compose 里所有 `image:` 必须能拉到。
 *
 * 2026-11 的真实故障：`minio/minio:RELEASE.2025-09-07T16-13-09Z` 在 v0.1.1 时还能
 * 拉，发 v0.1.2 时被 MinIO 从 Docker Hub / quay / ghcr **全部撤下**（许可证变更后
 * 公开镜像不再提供）。CI 冒烟 job 因此红在 `docker compose up` 的第一步，
 * 而镜像、签名、产物、Release 其实全都发布成功了 —— 这种「只有一条门禁红、原因
 * 与代码无关」的状态最容易被当成偶发忽略掉。
 *
 * 这些断言不能联网验证 tag 是否存在（CI 与本机都可能没有外网），它们锁住的是
 * **我们已经知道的坑**：不要退回那个已被撤下的镜像。
 */

const root = path.resolve(__dirname, '../../..');
const compose = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
const cluster = readFileSync(path.join(root, 'docker-compose.cluster.yml'), 'utf8');

/** 去掉注释行，只留下真正生效的指令。 */
function live(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

describe('docker-compose 的镜像来源', () => {
  const text = live(compose);

  it('不再引用已被撤下的 minio/minio', () => {
    // 这个 tag 在三个 registry 上都无法匿名拉取，`docker compose up` 会直接失败。
    expect(text).not.toMatch(/image:\s*minio\/minio/);
  });

  it('对象存储用 Silo（MinIO 的兼容分支）', () => {
    const images = [...text.matchAll(/image:\s*(\S+)/g)].map((match) => match[1]);
    const storage = images.filter((image) => image.includes('silo') || image.includes('minio'));
    expect(storage.length, '找不到对象存储镜像').toBeGreaterThanOrEqual(2);
    for (const image of storage) {
      expect(image).toContain('pgsty/silo');
    }
  });

  it('对象存储镜像可被 MINIO_IMAGE 覆盖（换实现不必改 compose）', () => {
    expect(text).toMatch(/image:\s*\$\{MINIO_IMAGE:-pgsty\/silo:/);
  });

  it('健康检查用 silo 自带探针，而不是依赖别处 set 的 mc 别名', () => {
    // 原配置 `mc ready local` 是坏的：`local` 别名在 minio-init 容器里才 set，
    // 健康检查跑在对象存储容器里根本看不到它 —— 那个 healthcheck 从来没有
    // 真正验证过任何东西。
    expect(text).toMatch(/test:\s*\['CMD',\s*'silo',\s*'healthcheck',\s*'ready'\]/);
    expect(text).not.toMatch(/test:\s*\['CMD',\s*'mc',\s*'ready',\s*'local'\]/);
  });

  it('Silo 保留 MINIO_* 环境变量契约（不是 SILO_*）', () => {
    // 改了变量名就要同时改 api 侧配置与运维的 .env，属于无收益的破坏性变更。
    expect(text).toContain('MINIO_ROOT_USER');
    expect(text).toContain('MINIO_ROOT_PASSWORD');
    expect(text).not.toMatch(/SILO_ROOT_(USER|PASSWORD)/);
  });
});

describe('docker-compose.cluster.yml 的镜像来源', () => {
  it('不引用已被撤下的 minio/minio', () => {
    expect(live(cluster)).not.toMatch(/image:\s*minio\/minio/);
  });
});
