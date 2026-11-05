import { describe, expect, it } from 'vitest';
import { isUniqueViolation, upsertIgnoringRace } from '../../src/lib/prisma-race.ts';

/**
 * 守卫：api 与 worker 并发 seed 权限不得让**全新安装启动即崩**。
 *
 * v0.1.4 冒烟实测：全新库 `docker compose up`，api 与 worker 同时执行
 * `seedPlatformPermissions()`，Prisma `upsert` 的 select-then-insert 撞唯一约束，
 * 抛 `P2002 duplicate key value violates unique constraint
 * "group_permissions_pkey"`，api 进入重启循环，冒烟 0/1 通过。
 */

describe('唯一约束冲突的幂等写入', () => {
  it('识别 Prisma P2002', () => {
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
  });

  it('识别 Prisma 7 driver adapter 藏在 meta 里的 23505', () => {
    // 线上实测形态：code 不在顶层，而是 driverAdapterError.cause.originalCode。
    expect(
      isUniqueViolation({
        code: 'P2002',
        meta: { driverAdapterError: { cause: { originalCode: '23505' } } },
      }),
    ).toBe(true);
    expect(
      isUniqueViolation({ meta: { driverAdapterError: { cause: { originalCode: '23505' } } } }),
    ).toBe(true);
  });

  it('不把无关错误当成冲突（吞错误比冲突更危险）', () => {
    expect(isUniqueViolation({ code: 'P2003' })).toBe(false);
    expect(isUniqueViolation(new Error('connection refused'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('P2002')).toBe(false);
  });

  it('冲突时调用 recover 取回对手写入的行', async () => {
    const value = await upsertIgnoringRace(
      async () => {
        throw { code: 'P2002' };
      },
      async () => 'existing-row',
    );
    expect(value).toBe('existing-row');
  });

  it('非冲突错误必须继续抛出', async () => {
    await expect(
      upsertIgnoringRace(async () => {
        throw new Error('database is down');
      }),
    ).rejects.toThrow('database is down');
  });

  it('并发两份同样的写入只成功一次、另一次静默', async () => {
    // 模拟 api 与 worker 同时 insert：先到的成功，后到的收到 P2002。
    let inserted = false;
    const write = async () => {
      if (inserted) throw { code: 'P2002' };
      inserted = true;
      return 'created';
    };
    const results = await Promise.allSettled([
      upsertIgnoringRace(write),
      upsertIgnoringRace(write),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });
});
