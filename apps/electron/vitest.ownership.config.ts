import { defineConfig } from 'vitest/config'

/** Built Host and external CLI process regression; build both applications first. */
export default defineConfig({
  test: {
    include: ['tests/ownership.runtime.e2e.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
})
