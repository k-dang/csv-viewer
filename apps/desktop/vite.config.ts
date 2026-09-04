import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: desktopRoot,
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(desktopRoot, '../../packages/ui/src'),
    },
  },
  build: {
    outDir: path.resolve(desktopRoot, 'dist-renderer'),
    emptyOutDir: true,
  },
  server: {
    fs: {
      allow: [path.resolve(desktopRoot, '../..')],
    },
    watch: {
      ignored: ['**/fixtures/**', '**/*.csv', '**/*.tsv', '**/*.txt'],
    },
  },
});
