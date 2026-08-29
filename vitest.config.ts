import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'parsers',
          root: './packages/parsers',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'core',
          root: './packages/core',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'dns',
          root: './packages/dns',
          include: ['test/**/*.test.ts'],
          // Network-dependent specs are tagged `[network]` and excluded from the
          // default run so CI never fails on someone else's outage.
          exclude: ['test/**/*.network.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'dns-network',
          root: './packages/dns',
          include: ['test/**/*.network.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'store',
          root: './packages/store',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'crawler',
          root: './apps/crawler',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['packages/parsers/src/**/*.ts', 'packages/store/src/**/*.ts'],
      exclude: ['**/index.ts'],
      thresholds: {
        // Section 5, Phase 1 acceptance: >=90% branch coverage on the parsers.
        'packages/parsers/src/**/*.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
      },
    },
  },
});
