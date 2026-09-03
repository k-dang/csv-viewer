import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../../packages/ui/src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist-renderer'),
    emptyOutDir: true,
  },
  server: {
    fs: {
      allow: [path.resolve(__dirname, '../..')],
    },
    watch: {
      ignored: ['**/fixtures/**', '**/*.csv', '**/*.tsv', '**/*.txt'],
    },
  },
});
