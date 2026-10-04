import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import { rule as noRawColourRule } from './eslint/no-raw-colour.mjs'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // eslint/*.mjs has no imports (ENGINEERING §1) and needs no type
          // information of its own — same default-project carve-out as the
          // config files above it.
          allowDefaultProject: ['*.config.mts', '*.config.mjs', 'scripts/*.mjs', 'eslint/*.mjs']
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
    files: ['*.config.mts', '*.config.mjs', 'scripts/*.mjs', 'eslint/*.mjs'],
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
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
      port: { rules: { 'no-raw-colour': noRawColourRule } }
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
      // The useEffect ban is total (ticket's own "Risks" note) — TanStack
      // Query, useSyncExternalStore, or a ref callback cover every real use.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react',
              importNames: ['useEffect', 'useLayoutEffect'],
              message: 'useEffect/useLayoutEffect are banned here — use TanStack Query, useSyncExternalStore, or a ref callback instead.'
            }
          ]
        }
      ],
      'no-restricted-properties': [
        'error',
        { object: 'React', property: 'useEffect', message: 'useEffect is banned here — use TanStack Query, useSyncExternalStore, or a ref callback instead.' },
        { object: 'React', property: 'useLayoutEffect', message: 'useLayoutEffect is banned here — use TanStack Query, useSyncExternalStore, or a ref callback instead.' }
      ],
      'port/no-raw-colour': 'error'
    }
  },
  eslintConfigPrettier
)
