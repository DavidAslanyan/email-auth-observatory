// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import prettier from 'eslint-config-prettier';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/node_modules/**',
      '**/coverage/**',
      'data/**',
      'reports/**',
      'apps/web/public/data/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root-level tooling config only. Test directories carry their own
          // tsconfig.json (non-composite, noEmit) so tests are type-aware
          // linted and type-checked without being emitted into dist.
          allowDefaultProject: ['*.ts', '*.js', 'scripts/*.d.mts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({
          alwaysTryTypes: true,
          noWarnOnMultipleProjects: true,
          project: ['packages/*/tsconfig.json', 'apps/*/tsconfig.json'],
        }),
      ],
    },
    rules: {
      // Concurrency-heavy codebase: an unawaited promise here means a crawl that
      // reports success while half its lookups are still in flight.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Makes LookupStatus handling provably total. If a fifth state is ever
      // added, every switch over it fails to compile-lint until it is handled.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],

      // Structured logging via pino; stray console.log in a crawl loop produces
      // gigabytes of unparseable Actions output.
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // The dependency direction in the plan's section 3 is only meaningful if
      // cycles are impossible.
      'import-x/no-cycle': ['error', { maxDepth: Infinity }],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'dns',
              message:
                'node:dns hides RCODE and the AD flag. Use @mailscape/dns — see plan section 4.2.1.',
            },
            {
              name: 'node:dns',
              message:
                'node:dns hides RCODE and the AD flag. Use @mailscape/dns — see plan section 4.2.1.',
            },
            {
              name: 'node:dns/promises',
              message:
                'node:dns hides RCODE and the AD flag. Use @mailscape/dns — see plan section 4.2.1.',
            },
          ],
        },
      ],
    },
  },

  // parsers are pure: no I/O, no network, no clock, no randomness.
  {
    files: ['packages/parsers/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'dns', '@mailscape/dns', '@mailscape/store'],
              message:
                'packages/parsers must stay pure — string in, structured object out. See plan section 4.3.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'parsers are pure: no network.' },
      ],
    },
  },

  // core has no dependency on any other mailscape package.
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@mailscape/*'],
              message: 'core sits at the bottom of the dependency graph. See plan section 3.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['**/*.test.ts', '**/test/**/*.ts', 'vitest.config.ts', 'eslint.config.js'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },

  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    // Fixture capture scripts run under Node with no bundler and no types.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        AbortSignal: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  prettier,
);
