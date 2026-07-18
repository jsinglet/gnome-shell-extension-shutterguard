import stylistic from '@stylistic/eslint-plugin';

export default [
    {
        files: ['build/compiled/*.js'],
        plugins: {
            '@stylistic': stylistic,
        },
        rules: {
            '@stylistic/lines-between-class-members': [
                'error',
                'always',
            ],
            '@stylistic/padding-line-between-statements': [
                'error',
                {
                    blankLine: 'always',
                    prev: '*',
                    next: ['function', 'class'],
                },
                {
                    blankLine: 'always',
                    prev: ['function', 'class'],
                    next: '*',
                },
            ],
        },
    },
];