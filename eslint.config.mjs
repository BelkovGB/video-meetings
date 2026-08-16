import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    // Оркестратор Ralph. Без этого блока `scripts/**` не покрыт линтом, и
    // мёртвые импорты вместе с необъявленными кросс-модульными вызовами
    // приходится считать вручную.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      // tseslint.configs.recommended применяется ко всем файлам и уже включает
      // свою версию правила. Базовое выключено, иначе каждая находка
      // отчитывается дважды.
      'no-unused-vars': 'off',
      // ignoreRestSiblings разрешает идиому «выбросить ключ»:
      // `const { a, ...rest } = obj` в тестах конфигурации.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  eslintConfigPrettier,
);
