import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const electronEntries = {
  main: path.resolve(desktopRoot, 'src/main/main.ts'),
  preload: path.resolve(desktopRoot, 'src/preload/index.ts'),
} as const;

type ElectronEntryName = keyof typeof electronEntries;

function isElectronEntryName(value: string): value is ElectronEntryName {
  return value in electronEntries;
}

/** Main and preload are separate bundles so preload never depends on a generated shared chunk. */
export default defineConfig((configEnvironment) => {
  const entryName = configEnvironment.mode;
  if (!isElectronEntryName(entryName)) {
    throw new Error(`Expected Electron build mode "main" or "preload", received "${entryName}".`);
  }

  return {
    build: {
      target: 'node22',
      outDir: path.resolve(desktopRoot, 'dist-electron'),
      emptyOutDir: entryName === 'main',
      sourcemap: true,
      minify: false,
      lib: {
        entry: electronEntries[entryName],
        formats: ['cjs'],
        fileName: () => `${entryName}.cjs`,
      },
      rollupOptions: {
        external: (id) => id === 'electron' || id === '@duckdb/node-api' || id.startsWith('node:'),
      },
    },
  };
});
