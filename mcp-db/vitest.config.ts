import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000, // Database tests might be slower
    hookTimeout: 10000,
    environment: 'node',
    globalSetup: ['./tests/globalSetup.ts'],
    globals: true,
    coverage: {
      // Vitest 4 dropped coverage.all and now reports only files a test
      // loaded; include keeps untested source files in the denominator.
      include: ['src/**/*.ts', 'migrations/**/*.ts'],
      reporter: ['text', 'json-summary', 'json'],
      thresholds: {
        lines: 85,
        // 84, not 85: Vitest 4's AST-aware V8 remapping counts more branches
        // than Vitest 3 did. The identical suite measured 94.0% under
        // Vitest 3 and 84.4% under Vitest 4 -- a measurement change, not
        // lost tests.
        branches: 84,
        functions: 85,
        statements: 85,
      },
    },
  },
})
