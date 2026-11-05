import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeConfigFromEnv, validateComposeConfig } from '../src/compose-config.ts';

/**
 * 真实临时 project 目录。
 *
 * env 文件可读性校验（P1-C）要求它真的存在 —— 用假路径会让所有用例被
 * fail-closed 拒绝，而那正是这个校验的意义。
 */
const PROJECT_DIR = mkdtempSync(path.join(tmpdir(), 'sp-cfg-'));
mkdirSync(path.join(PROJECT_DIR, 'docker'), { recursive: true });
writeFileSync(path.join(PROJECT_DIR, 'docker/.env'), 'POSTGRES_PASSWORD=secret\n');

/**
 * 绑定配置装配（§5.1）。重点钉住 `UPDATER_ENV_FILE`：
 *
 * updater 在容器里执行 `docker compose`，它的进程环境里**没有** `docker/.env`
 * 里的密钥。真机升级演练时因为没有 `--env-file`，compose 把 `${POSTGRES_PASSWORD}`
 * 插值成空串，`up -d` 会用空密码重建 postgres——一次「成功」的升级把实例锁死。
 */

function baseEnv(): NodeJS.ProcessEnv {
  return {
    UPDATER_INSTANCE_ID: 'stackpanel',
    UPDATER_COMPOSE_PROJECT: PROJECT_DIR,
    UPDATER_IMAGE_REPOSITORY: 'ghcr.io/acme/stackpanel',
  };
}

describe('composeConfigFromEnv', () => {
  it('缺省不带 envFile（自定义部署可能把变量直接放进进程环境）', () => {
    const config = composeConfigFromEnv(baseEnv());
    expect(config.envFile).toBeUndefined();
  });

  it('UPDATER_ENV_FILE 原样带出，供 compose 加 --env-file', () => {
    const config = composeConfigFromEnv({ ...baseEnv(), UPDATER_ENV_FILE: 'docker/.env' });
    expect(config.envFile).toBe('docker/.env');
  });

  it('空字符串的 envFile 被拒绝（半配置比不配置更危险）', () => {
    expect(() =>
      validateComposeConfig({
        ...composeConfigFromEnv(baseEnv()),
        envFile: '   ',
      }),
    ).toThrow(/envFile/);
  });

  it('UPDATER_COMPOSE_FILES 逗号分隔成多文件', () => {
    const config = composeConfigFromEnv({
      ...baseEnv(),
      UPDATER_COMPOSE_FILES: 'docker-compose.yml,docker-compose.drill.yml',
    });
    expect(config.composeFiles).toEqual(['docker-compose.yml', 'docker-compose.drill.yml']);
  });
});
