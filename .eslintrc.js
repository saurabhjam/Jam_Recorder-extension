/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  extends: ['@snaptrace/eslint-config'],
  rules: {
    // These rules require parserOptions.project (type-aware linting).
    // Disabled here at root level; each app's own .eslintrc enables them
    // with its local tsconfig.
    '@typescript-eslint/no-floating-promises': 'off',
    '@typescript-eslint/await-thenable': 'off',
    '@typescript-eslint/no-misused-promises': 'off',
    '@typescript-eslint/require-await': 'off',
    '@typescript-eslint/no-unsafe-assignment': 'off',
    '@typescript-eslint/no-unsafe-call': 'off',
    '@typescript-eslint/no-unsafe-member-access': 'off',
    '@typescript-eslint/no-unsafe-return': 'off',
  },
};
