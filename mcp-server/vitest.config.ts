import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: loadEnv('', process.cwd(), ''),
    testTimeout: 10000,
    coverage: {
      // Vitest 4 dropped coverage.all and now reports only files a test
      // loaded; include keeps untested source files in the denominator.
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary', 'json'],
      thresholds: {
        lines: 85,
        // 82, not 85: Vitest 4's AST-aware V8 remapping counts more branches
        // (??, ?., default params) than Vitest 3 did. The identical suite
        // measured 88.3% under Vitest 3 and 82.9% under Vitest 4, with every
        // file dropping similarly -- a measurement change, not lost tests.
        branches: 82,
        functions: 85,
        statements: 85,
      },
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['**/*.test.ts', '**/*.spec.ts'],
          exclude: [
            '**/*.integration.test.ts',
            'node_modules/**',
            'dist/**',
            'build/**',
          ],
          pool: 'threads',
          // No globalSetup here: every unit test mocks pg/DatabaseService, so
          // the unit project runs without Docker or a database. Only the
          // integration project needs the docker-compose test database.
          setupFiles: ['./tests/setup.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['**/*.integration.test.ts'],
          exclude: ['node_modules/**', 'dist/**', 'build/**'],
          pool: 'forks',
          // Vitest 4 equivalent of the old poolOptions.forks.singleFork:
          // one worker, no per-file module isolation (the shared test
          // database is the reason these run serially).
          maxWorkers: 1,
          isolate: false,
          fileParallelism: false,
          testTimeout: 30000,
          retry: 3,
          globalSetup: ['./tests/globalSetup.ts'],
          setupFiles: ['./tests/setup.ts'],
        },
      },
    ],
  },
})
