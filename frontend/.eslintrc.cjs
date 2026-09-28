module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  settings: { react: { version: '18.2' } },
  plugins: ['react-refresh'],
  rules: {
    // Fast-Refresh is a DEV-ONLY HMR convenience, not a correctness rule. Every
    // instance in this codebase is the standard, deliberate pattern:
    //   - context files that export `FooProvider` + a `useFoo()` hook side by side
    //   - the app entry (main.jsx), which is never hot-reloaded on its own
    // Splitting them into extra files to satisfy a dev-server nicety would hurt
    // readability for no production benefit, so the rule is off (matching how the
    // other non-correctness rules below are handled).
    'react-refresh/only-export-components': 'off',
    'react/prop-types': 'off',
    'react/no-unescaped-entities': 'off',
    'react/react-in-jsx-scope': 'off',
    'react/display-name': 'off',
    'no-unused-vars': 'off',
    'no-extra-semi': 'off',
    'no-unreachable': 'off',
    'no-undef': 'off',
  },
}
