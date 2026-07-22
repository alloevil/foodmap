'use strict';

const js = require('@eslint/js');
const prettier = require('eslint-config-prettier');

module.exports = [
    { ignores: ['node_modules/**', 'data/**'] },
    js.configs.recommended,
    prettier,
    {
        files: ['*.js', 'lib/**/*.js', 'test/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: {
                require: 'readonly',
                module: 'writable',
                process: 'readonly',
                __dirname: 'readonly',
                console: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                globalThis: 'readonly',
                fetch: 'readonly',
                URL: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-undef': 'error',
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-irregular-whitespace': 'off',
        },
    },
    {
        files: ['**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                process: 'readonly',
                console: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                globalThis: 'readonly',
                fetch: 'readonly',
                URL: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-undef': 'error',
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-irregular-whitespace': 'off',
        },
    },
    // verify-render.js / login.mjs 含 puppeteer page.evaluate 回调，在浏览器上下文执行
    {
        files: ['verify-render.js', 'login.mjs'],
        languageOptions: {
            globals: {
                document: 'readonly',
                window: 'readonly',
                location: 'readonly',
            },
        },
    },
];
