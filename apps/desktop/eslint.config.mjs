import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'
import * as importX from 'eslint-plugin-import-x'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import { RENDERER_PATHS, RENDERER_SYNTAX, boundaryBlocks } from './eslint/boundaries.mjs'
import { rule as noRawColourRule } from './eslint/no-raw-colour.mjs'
import { rule as noParentImportRule } from './eslint/no-parent-import.mjs'

/** Every source file the boundaries govern, repo-relative to this directory with forward slashes. */
const boundedFiles = ['src', 'tests/fixtures/app'].flatMap((dir) =>
  readdirSync(join(import.meta.dirname, dir), { recursive: true, encoding: 'utf8' })
    .map((f) => `${dir}/${f.split('\\').join('/')}`)
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
)

// Defined once: ESLint rejects the same plugin key bound to two different objects when two blocks' files globs overlap.
const portPlugin = { rules: { 'no-raw-colour': noRawColourRule, 'no-parent-import': noParentImportRule } }

export default tseslint.config(
  { ignores: ['out/**', 'dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    plugins: { port: portPlugin },
    languageOptions: {
      parserOptions: {
        projectService: {
          // eslint/*.mjs has no imports (ENGINEERING §1) and needs no type
          // information of its own — same default-project carve-out as the
          // config files above it.
          allowDefaultProject: ['*.config.mts', '*.config.mjs', 'scripts/*.mjs', 'eslint/*.mjs', 'tests/e2e/fake/*.mjs']
        },
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error'
    }
  },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    rules: {
      'port/no-parent-import': 'error'
    }
  },
  {
    files: ['*.config.mts', '*.config.mjs', 'scripts/*.mjs', 'eslint/*.mjs', 'tests/e2e/fake/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        console: 'readonly',
        process: 'readonly'
      }
    }
  },
  // The React stack (#316) — React and hooks rules, plus the local
  // port/no-raw-colour rule, scoped to the renderer only.
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'tests/unit/renderer/**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks
    },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    settings: {
      // A literal version, not 'detect': eslint-plugin-react's own
      // auto-detection calls a legacy `context.getFilename()` ESLint 10
      // removed, crashing the whole run — see its own lib/util/version.js.
      react: { version: '19.3.0' }
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      ...reactHooks.configs.flat.recommended.rules,
      'react/no-danger': 'error',
      // TypeScript types every prop; `prop-types` would just be a second,
      // unenforced copy of the same contract.
      'react/prop-types': 'off',
      // TanStack Router's own redirect() throws a Response-shaped value
      // (Redirect = Response & {...}), not an Error — the framework's own
      // documented interrupt-navigation pattern, not a thrown literal.
      '@typescript-eslint/only-throw-error': ['error', { allow: [{ from: 'lib', name: 'Response' }] }],
      // The useEffect ban is total — TanStack Query, useSyncExternalStore, or a ref callback cover every real use.
      // src/ files get these lists merged into their boundary block; tests/unit/renderer takes them from here.
      'no-restricted-imports': ['error', { paths: RENDERER_PATHS }],
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-properties': [
        'error',
        { object: 'React', property: 'useEffect', message: 'useEffect is banned here — use TanStack Query, useSyncExternalStore, or a ref callback instead.' },
        { object: 'React', property: 'useLayoutEffect', message: 'useLayoutEffect is banned here — use TanStack Query, useSyncExternalStore, or a ref callback instead.' },
        { object: 'document', property: 'createElement', message: 'createElement is banned here — render JSX instead.' },
        { object: 'document', property: 'createElementNS', message: 'createElementNS is banned here — render JSX instead.' },
        { object: 'document', property: 'createTextNode', message: 'createTextNode is banned here — render JSX instead.' },
        { object: 'document', property: 'write', message: 'document.write is banned here — render JSX instead.' }
      ],
      'no-restricted-syntax': ['error', ...RENDERER_SYNTAX],
      'port/no-raw-colour': 'error'
    }
  },
  // The visual harness (#317) — Playwright's own test-hook signature requires
  // an empty object destructuring pattern for an unused leading `fixtures`
  // parameter (`test.afterEach(async ({}, testInfo) => …)`); that shape is
  // the framework's own contract, never a lint complaint about real code.
  {
    files: ['tests/visual/**/*.mts', 'tests/e2e/**/*.mts'],
    rules: {
      'no-empty-pattern': 'off'
    }
  },
  // A runtime import cycle between two source files. Type-only imports are skipped by the rule.
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'import-x': importX },
    settings: {
      ...importX.flatConfigs.typescript.settings,
      'import-x/resolver-next': [createTypeScriptImportResolver({ project: 'tsconfig.json', references: 'auto' })]
    },
    rules: { 'import-x/no-cycle': 'error' }
  },
  // The import, global and syntax boundaries — kept after every block above and before the Prettier reset,
  // since a later block replaces a rule's options rather than merging them.
  ...boundaryBlocks(boundedFiles),
  eslintConfigPrettier
)
