const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      '.opencode/**',
      '.agents/**',
      'prisma/**',
      'uploads/**',
      'tests/**',
      'scripts/demo/**',
      'plans/**',
      'tasks/**',
    ],
  },
  {
    name: 'e-learning-platform:src',
    files: ['src/**/*.js', 'app.js', '*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.commonjs,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
];