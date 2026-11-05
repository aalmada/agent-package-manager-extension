import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.vscode-test/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,mjs}'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', document: 'readonly', window: 'readonly', HTMLElement: 'readonly', HTMLInputElement: 'readonly', HTMLSelectElement: 'readonly', HTMLTextAreaElement: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly', Buffer: 'readonly', NodeJS: 'readonly' }
    }
  }
);
