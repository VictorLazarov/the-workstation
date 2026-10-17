import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { buildTargets } from './browser-targets';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7777',
      '/ws': { target: 'ws://127.0.0.1:7777', ws: true },
    },
  },
  // target = browserslist floors (Safari 16.4 / Firefox 115 / Chrome 111): esbuild lowers syntax and CSS (nesting etc.) to them
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500, target: buildTargets, cssTarget: buildTargets },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
