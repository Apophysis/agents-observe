import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  // Tests are excluded from tsconfig.app.json (Docker build), so set the JSX transform here.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    // polyfill-storage must run first: it installs localStorage before
    // setup.ts's import chain (and any store module) is evaluated.
    setupFiles: ['./src/test/polyfill-storage.ts', './src/test/setup.ts'],
    css: false,
  },
})
