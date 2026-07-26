import js from '@eslint/js';
import importX from 'eslint-plugin-import-x';
import perfectionist from 'eslint-plugin-perfectionist';
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
        plugins: {
            'import-x': importX,
            perfectionist,
        },
        rules: {
            eqeqeq: ['error', 'always'],

            // No imports buried mid-file.
            'import-x/first': 'error',

            // Whole-module imports first, then destructuring ones, each
            // block alphabetized by module name.
            'perfectionist/sort-imports': [
                'error',
                {
                    type: 'alphabetical',
                    order: 'asc',
                    ignoreCase: true,
                    newlinesBetween: 1,
                    groups: ['default-import', 'named-import', 'unknown'],
                },
            ],
        },
    },
];
