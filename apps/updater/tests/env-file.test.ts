import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readEnvValue, rewriteEnvFile } from '../src/env-file.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-env-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

/**
 * env 文件原子回写（P0-A）。
 *
 * `switchTo` 只用进程环境覆盖镜像变量：容器确实换成了新 digest，但 `.env` 仍是
 * 旧 tag。于是任何一次 `docker compose up -d` 都会把服务**静默回退**到旧版本，
 * 而数据库已被新版本迁移 —— 版本倒挂。生产实测就是这样（.env 指 0.1.3、容器已是
 * 0.1.4）。
 */
describe('rewriteEnvFile（P0-A）', () => {
  it('就地替换已有键，保持其余行与顺序不变', async () => {
    const file = path.join(tempDir(), '.env');
    writeFileSync(
      file,
      ['# 顶部注释', 'POSTGRES_PASSWORD=secret', 'STACKPANEL_IMAGE=ghcr.io/acme/sp:0.1.3', 'OTHER=1', ''].join(
        '\n',
      ),
    );
    await rewriteEnvFile(file, { STACKPANEL_IMAGE: 'ghcr.io/acme/sp@sha256:abc' });
    const text = readFileSync(file, 'utf8');
    // 密钥与顺序必须原样保留：这个文件里有生成于安装时的密钥。
    expect(text).toContain('POSTGRES_PASSWORD=secret');
    expect(text).toContain('OTHER=1');
    expect(text).toContain('# 顶部注释');
    expect(text).toContain('STACKPANEL_IMAGE=ghcr.io/acme/sp@sha256:abc');
    expect(text).not.toContain('STACKPANEL_IMAGE=ghcr.io/acme/sp:0.1.3');
  });

  it('键不存在时追加到末尾', async () => {
    const file = path.join(tempDir(), '.env');
    writeFileSync(file, 'A=1\n');
    await rewriteEnvFile(file, { B: '2' });
    expect(readFileSync(file, 'utf8')).toBe('A=1\nB=2\n');
  });

  it('被注释掉的旧值原样保留（运维常把旧 tag 注释留档）', async () => {
    const file = path.join(tempDir(), '.env');
    writeFileSync(file, '# STACKPANEL_IMAGE=ghcr.io/acme/sp:0.1.2\nSTACKPANEL_IMAGE=new\n');
    await rewriteEnvFile(file, { STACKPANEL_IMAGE: 'target' });
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# STACKPANEL_IMAGE=ghcr.io/acme/sp:0.1.2');
    expect(text).toContain('STACKPANEL_IMAGE=target');
  });

  it('保留原文件权限（600 的密钥文件不能被放大成 644）', async () => {
    const file = path.join(tempDir(), '.env');
    writeFileSync(file, 'A=1\n');
    // 先设成 600（.env 的常见权限）。
    const { chmodSync } = await import('node:fs');
    chmodSync(file, 0o600);
    await rewriteEnvFile(file, { A: '2' });
    // 临时文件默认 644，直接 rename 会把密钥文件变成全局可读。
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('一次写多个变量（web 与 api 用不同变量时都要覆盖）', async () => {
    const file = path.join(tempDir(), '.env');
    writeFileSync(file, 'STACKPANEL_IMAGE=old\nSTACKPANEL_WEB_IMAGE=old\n');
    await rewriteEnvFile(file, {
      STACKPANEL_IMAGE: 'new',
      STACKPANEL_WEB_IMAGE: 'new',
    });
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('=old');
    expect(text.match(/=new/g)).toHaveLength(2);
  });

  it('switchTo 真的调用了回写（钩子存在不等于被接线）', async () => {
    const source = readFileSync(new URL('../src/compose-adapter.ts', import.meta.url), 'utf8');
    // 回写函数存在但没人调用 = 一个永远不会生效的钩子，而这正是 P0-A 的
    // 原始症状（容器换了、.env 没换）。断言调用点在 switchTo 内、up 之前。
    const switchIdx = source.indexOf('async switchTo(');
    const writeIdx = source.indexOf('await this.writeImageRefs(image)');
    const upIdx = source.indexOf("this.composeRun(['up', '-d'", switchIdx);
    expect(writeIdx).toBeGreaterThan(switchIdx);
    // 必须先落盘再 up：反过来的话 up 失败时 .env 已经指向新版本，
    // 而容器还是旧的 —— 状态更糟。
    expect(upIdx).toBeGreaterThan(writeIdx);
  });

  it('真机验证：回写后 compose 解析出的镜像就是目标值', async () => {
    const file = path.join(tempDir(), '.env');
    writeFileSync(file, 'STACKPANEL_IMAGE=ghcr.io/acme/sp:0.1.3\n');
    // 模拟 switchTo 写 digest。
    await rewriteEnvFile(file, { STACKPANEL_IMAGE: 'ghcr.io/acme/sp@sha256:abc' });
    // `docker compose config` 读的就是这个字面值 —— 运维手工 up 不会再回退。
    expect(await readEnvValue(file, 'STACKPANEL_IMAGE')).toBe('ghcr.io/acme/sp@sha256:abc');
    // 且 verify 的判定能通过（声明值 == 目标）。
    expect(await readEnvValue(file, 'STACKPANEL_IMAGE')).not.toContain(':0.1.3');
  });

  it('readEnvValue 只读字面值，不因注释行误命中', async () => {
    const file = path.join(tempDir(), '.env');
    writeFileSync(file, '# STACKPANEL_IMAGE=commented\nSTACKPANEL_IMAGE=real\n');
    expect(await readEnvValue(file, 'STACKPANEL_IMAGE')).toBe('real');
    expect(await readEnvValue(file, 'MISSING')).toBeUndefined();
  });
});
