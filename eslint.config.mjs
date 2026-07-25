import js from '@eslint/js';
import globals from 'globals';

export default [
    { ignores: ['scratch/'] },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: globals.node,
        },
        rules: {
            eqeqeq: ['error', 'always'],
        },
    },
];
