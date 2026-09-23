// Minimal backend lint gate: ESM syntax errors + unused vars/prefix rules.
// Run: cd backend && npm run lint (fails loudly — never masked in CI).
export default [
  {
    ignores: ['node_modules/**', 'storage/**', 'data.db'],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        crypto: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-undef': 'error',
      'no-redeclare': 'error',
    },
  },
  {
    // Test scripts intentionally hold side-effect handles (inserted rows,
    // started servers); unused bindings there are harmless.
    files: ['tests/**/*.mjs', 'scripts/**/*.mjs'],
    rules: {
      'no-unused-vars': 'off',
    },
  },
]
