import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['{app,components,lib,hooks,stores}/**/*.{test,spec}.{ts,tsx}', 'test/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', '.next', 'tests/e2e/**'],
    reporters: process.env.CI
      ? ['default', ['junit', { outputFile: 'test-report/junit.xml' }], ['html', { outputFile: 'test-report/index.html' }]]
      : ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary', 'lcov'],
      reportsDirectory: 'test-report/coverage',
      include: ['lib/offline/**/*.{ts,tsx}'],
      thresholds: {
        'lib/offline/**': {
          lines: 85,
          functions: 85,
          branches: 80,
          statements: 85,
        },
      },
    },
  },
});
