import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		fs: {
			allow: ['..']
		}
	},
	optimizeDeps: {
		exclude: ['web-tree-sitter']
	},
	resolve: {
		alias: {
			'web-tree-sitter': path.resolve(__dirname, 'node_modules/web-tree-sitter')
		}
	}
});
