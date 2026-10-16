import { defineConfig } from 'tsup';

export default defineConfig({
  // `main.ts` 是可部署的独立执行器；`drill.ts` 只导出升级引擎/适配器面，供
  // `scripts/release/updater-drill.mjs` 在**不接触 Docker** 时做干净机器演练（§13-7）。
  entry: ['src/main.ts', 'src/drill.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  // 独立 updater 镜像预置 docker/compose 客户端与 pg 备份工具；执行器通过
  // `node:child_process` 调用它们，故这些工具不打包进 JS。`@stackpanel/spec` 是
  // 零运行时依赖的契约包，直接内联，使运行时镜像无需任何 workspace node_modules。
  noExternal: ['@stackpanel/spec'],
  external: [],
});
