import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 发布链路的**结构守卫**。
 *
 * 背景（v0.1.3 真实漏发）：内核发布之后，更新中心永远只显示插件更新，看不到
 * 内核升级。因果链每一环都"看起来正常"，串起来才断：
 *
 *   v0.1.3 Release 已发
 *     → kernel-ref.json 只进了 Actions artifact（没进 Release 资产）
 *     → publish-catalog.yml 没有 --kernels
 *     → catalog.json 没有 kernels[]
 *     → catalogKernelRefs() 返回 []
 *     → loadKernelCandidates() 早退（refs.length === 0 直接 return []）
 *     → buildUpdatePlan() 拿不到 targetKernel（plan.ts 只在 length > 0 时才求）
 *     → 更新中心只显示插件更新
 *
 * 这些环节横跨两个 workflow 与三个模块，任何一处改错都不会报错 —— 只会静默地
 * 让内核升级消失。所以在这里把它们钉死。
 *
 * 为什么是文本断言而不是运行时：workflow 是 YAML、要真实 token 与远端 Release
 * 才能跑，没法在单测里端到端执行。文本断言至少能挡住"有人删掉某个参数/某行
 * 上传"这类最常见的回归。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('内核发布的目录链路（防止更新中心看不到内核升级）', () => {
  const release = read('.github/workflows/release.yml');
  const publishCatalog = read('.github/workflows/publish-catalog.yml');

  describe('release.yml：kernel-ref.json 必须进 Release 资产', () => {
    it('生成 kernel-ref.json', () => {
      // build-kernel-manifest.mjs 产出它；这里确认该步骤仍在。
      expect(release).toContain('build-kernel-manifest.mjs');
    });

    it('把 kernel-ref.json 上传到 Release（不只是 Actions artifact）', () => {
      // 找「发布内核清单与产物资产」那一步的 files 列表。
      const idx = release.indexOf('发布内核清单与产物资产');
      expect(idx, '找不到「发布内核清单与产物资产」步骤').toBeGreaterThan(0);
      const step = release.slice(idx, idx + 900);
      expect(step).toContain('softprops/action-gh-release');
      expect(step).toContain('kernel-out/kernel-ref.json');
    });

    it('同时仍上传为 Actions artifact（供排查与重放）', () => {
      const idx = release.indexOf('上传内核清单产物');
      expect(idx).toBeGreaterThan(0);
      expect(release.slice(idx, idx + 600)).toContain('kernel-ref.json');
    });
  });

  describe('publish-catalog.yml：必须能把内核引用写进目录', () => {
    it('接受 kernels 输入', () => {
      expect(publishCatalog).toMatch(/^\s{6}kernels:/m);
    });

    it('从 Release 下载 kernel-ref.json', () => {
      const idx = publishCatalog.indexOf('下载内核引用');
      expect(idx, '缺少「下载内核引用」步骤').toBeGreaterThan(0);
      const step = publishCatalog.slice(idx, idx + 1600);
      expect(step).toContain('gh release download');
      expect(step).toContain('kernel-ref.json');
      // 多个 tag 都叫 kernel-ref.json，不重命名会互相覆盖。
      expect(step).toContain('kernel-ref-$tag.json');
    });

    it('把 --kernels 传给 build-catalog.mjs', () => {
      // 必须断言**实际传参那一行**，不能只 `toContain('--kernels')`：
      // 注释里也出现了这个词，删掉代码后断言仍然会绿（实测踩过）。
      expect(publishCatalog).toMatch(/args\+=\(--kernels "\$RUNNER_TEMP\/kernels"\)/);
      // 传空目录会让 catalog 出现 `kernels: []`，与字段缺失同义但更具误导性。
      expect(publishCatalog).toMatch(/find "\$RUNNER_TEMP\/kernels" -name '\*\.json'/);
    });

    it('取不到任何内核引用时硬失败（不静默发布无内核的目录）', () => {
      const idx = publishCatalog.indexOf('下载内核引用');
      const step = publishCatalog.slice(idx, idx + 1600);
      expect(step).toContain('::error::');
      expect(step).toContain('exit 1');
    });
  });

  describe('消费端：catalog 没有 kernels[] 时确实是"看不到内核升级"', () => {
    it('loadKernelCandidates 在 refs 为空时早退', () => {
      const runtime = read('apps/api/src/updates/runtime.ts');
      const idx = runtime.indexOf('export async function loadKernelCandidates');
      expect(idx).toBeGreaterThan(0);
      const fn = runtime.slice(idx, idx + 700);
      expect(fn).toContain('catalogKernelRefs');
      // 这一行就是「目录没内核引用 → 直接返回空」的断点。
      expect(fn).toMatch(/refs\.length === 0\)\s*return \[\]/);
    });

    it('buildUpdatePlan 只在有候选时才求 targetKernel', () => {
      const plan = read('apps/api/src/updates/plan.ts');
      expect(plan).toMatch(/kernelCandidates\s*&&\s*input\.kernelCandidates\.length > 0/);
    });
  });
});
