import { describe, expect, it } from 'vitest';
import { composeConfigFromEnv, validateComposeConfig } from '../src/compose-config.ts';

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
    UPDATER_COMPOSE_PROJECT: '/workspace',
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
