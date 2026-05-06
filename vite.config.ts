import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer'),
    },
  },
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true,
  },
  server: {
    watch: {
      ignored: ['**/fixtures/**', '**/*.csv', '**/*.tsv', '**/*.txt'],
    },
  },
});
