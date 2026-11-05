import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeConfigFromEnv, validateComposeConfig } from '../src/compose-config.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-upd-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function env(projectDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    UPDATER_INSTANCE_ID: 'sp',
    UPDATER_COMPOSE_PROJECT: projectDir,
    UPDATER_IMAGE_REPOSITORY: 'ghcr.io/acme/stackpanel',
    ...extra,
  };
}

describe('updater 启动期校验（P1-C / P0-B）', () => {
  it('env 文件不可读时拒绝启动（fail-closed，不是等到升级中途才炸）', () => {
    const dir = tempDir();
    // 指向一个**不存在**的文件：容器里 `.env` 是 600 root:root 时就是这个效果。
    // 校验在装配阶段就生效（`composeConfigFromEnv` 末尾会 validate），
    // 所以把整个装配过程包起来 —— 拒绝必须发生在**启动期**，不是升级中途。
    let message = '';
    try {
      composeConfigFromEnv(env(dir, { UPDATER_ENV_FILE: 'docker/.env' }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('env 文件不可读');
    expect(message).toContain('640 root:docker');
  });

  it('env 文件可读时通过', () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, 'docker'), { recursive: true });
    writeFileSync(path.join(dir, 'docker/.env'), 'A=1\n');
    const config = composeConfigFromEnv(env(dir, { UPDATER_ENV_FILE: 'docker/.env' }));
    expect(() => validateComposeConfig(config)).not.toThrow();
  });

  it('不设 envFile 时不检查（自定义部署可能把变量放进进程环境）', () => {
    const config = composeConfigFromEnv(env(tempDir()));
    expect(() => validateComposeConfig(config)).not.toThrow();
  });

  it('UPDATER_DB_HOST 启用直连模式（外部托管 DB 无需跳板容器）', () => {
    const config = composeConfigFromEnv(
      env(tempDir(), {
        UPDATER_DB_HOST: '1Panel-postgresql',
        UPDATER_DB_PORT: '5433',
        UPDATER_DB_USER: 'app',
        UPDATER_DB_NAME: 'appdb',
        UPDATER_DB_PASSWORD: 'pw',
      }),
    );
    // 直连时不再依赖 compose 里的 db 服务：托管 DB 不在本 project 内，
    // `compose exec <svc> pg_dump` 会报 `no such service`。
    expect(config.database.connection).toEqual({
      host: '1Panel-postgresql',
      port: 5433,
      user: 'app',
      name: 'appdb',
      password: 'pw',
    });
  });

  it('没有 UPDATER_DB_HOST 时保持 compose 服务模式', () => {
    const config = composeConfigFromEnv(env(tempDir()));
    expect(config.database.connection).toBeUndefined();
    expect(config.database.service).toBe('postgres');
  });

  it('UPDATER_IMAGE_ENVS 带出额外镜像变量（web 与 api 不能不同步）', () => {
    const config = composeConfigFromEnv(
      env(tempDir(), { UPDATER_IMAGE_ENVS: 'STACKPANEL_WEB_IMAGE, STACKPANEL_API_IMAGE' }),
    );
    expect(config.imageEnvs).toEqual(['STACKPANEL_WEB_IMAGE', 'STACKPANEL_API_IMAGE']);
  });
});
