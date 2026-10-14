import type { Options } from 'tsup';

const shared = {
  format: ['esm'],
  outDir: 'dist',
  platform: 'neutral',
  sourcemap: true,
  external: ['next', 'react', 'react/jsx-runtime', '@stackpanel/sdk', '@stackpanel/ui', 'lucide-react', 'zod'],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
} satisfies Options;

export default [
  {
    ...shared,
    entry: ['src/index.tsx'],
    external: [...shared.external, './route-progress.js'],
  },
  {
    ...shared,
    entry: ['src/route-progress.tsx'],
    banner: { js: '"use client";' },
  },
] satisfies Options[];
