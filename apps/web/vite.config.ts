import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const envDir = resolve(import.meta.dirname, '../..');
  const env = loadEnv(mode, envDir, '');
  const fixtureMode = env.VITE_FIXTURE_MODE ?? env.FIXTURE_MODE ?? 'false';

  return {
    plugins: [react()],
    envDir,
    define: {
      'import.meta.env.VITE_FIXTURE_MODE': JSON.stringify(fixtureMode),
    },
    server: {
      port: Number.parseInt(env.VITE_PORT || '5173', 10),
      proxy: {
        '/api': {
          target: env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3210',
          changeOrigin: true,
        },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './src/test/setup.ts',
      css: true,
    },
  };
});
