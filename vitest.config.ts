import path from 'node:path'

import { defineConfig } from 'vitest/config'

// Minimal vitest config for the AI greeting send-verification bugfix.
// - jsdom env so Message.send() can run against fake window.GeekChatCore /
//   ChatWebsocket / EventBus and the iframe-clean console used by `@/utils/logger`.
// - Path aliases mirror `.wxt/tsconfig.json` so source files compile unchanged.
// - No watch script; `"test": "vitest --run"` is the only npm script we add.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    // Bug Condition tests rely on fast-check shrinking, give them a roomy budget
    // but still bounded so a Vitest run never hangs CI.
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@/': path.resolve(__dirname, './src') + '/',
      '~': path.resolve(__dirname, './src'),
      '~/': path.resolve(__dirname, './src') + '/',
      '@@': path.resolve(__dirname, '.'),
      '~~': path.resolve(__dirname, '.'),
    },
  },
})
