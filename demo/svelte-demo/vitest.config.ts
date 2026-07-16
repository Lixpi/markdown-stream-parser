import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
        exclude: ['.svelte-kit/**', 'dist/**', 'node_modules/**'],
    },
})
