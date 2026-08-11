import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Map the `@/…` path alias (tsconfig paths) so tests can import modules that use it.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '') },
  },
})
