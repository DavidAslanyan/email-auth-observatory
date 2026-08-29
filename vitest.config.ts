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
      // Coverage is measured on the two packages that hold the real logic. The
      // dns layer and the CLI are covered by integration checks instead.
      include: ['packages/parsers/src/**/*.ts', 'packages/store/src/**/*.ts'],
      exclude: ['**/index.ts'],
      thresholds: {
        // Plan section 5, phase 1 acceptance: >=90% branches on the parsers.
        'packages/parsers/src/**/*.ts': {
          branches: 90,
          functions: 90,
          lines: 95,
          statements: 95,
        },
        // Plan section 5, phase 3: the diff engine is the second-most important
        // file in the project and is tested exhaustively.
        'packages/store/src/**/*.ts': {
          branches: 85,
          functions: 90,
          lines: 90,
          statements: 90,
        },
      },
    },
  },
});
