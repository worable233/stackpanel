import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  // 独立 updater 镜像预置 docker/compose 客户端与 pg 备份工具；执行器通过
  // `node:child_process` 调用它们，故这些工具不打包进 JS。
  external: [],
});
