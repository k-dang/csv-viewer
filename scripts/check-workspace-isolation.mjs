import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The shared workspace runs in the Electron main process today and in a browser page once the web
 * runtime lands, so it must not reach for Electron or Node filesystem primitives, and the native
 * DuckDB driver must stay in the named database modules the web adapter will sit beside.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.join(repoRoot, 'src', 'workspace');
const duckDbDriver = '@duckdb/node-api';
const duckDbDriverModules = ['duckdb/duckdb-comparison-executor.ts', 'duckdb/duckdb-database.ts'];
const runtimeModules = [
  'electron',
  'fs',
  'fs/promises',
  'path',
  'os',
  'child_process',
  'worker_threads',
];

/** Matches static imports, `export ... from`, and dynamic `import()` under either quote style. */
function importedModules(contents) {
  const specifiers = [];
  const patterns = [
    /(?:^|\s)(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[^.\w])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|[^.\w])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\s)import\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of contents.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function isForbiddenRuntimeModule(specifier) {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return runtimeModules.includes(bare);
}

async function workspaceSourceFiles(directory = workspaceRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return workspaceSourceFiles(entryPath);
      if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) return [];
      return [entryPath];
    }),
  );
  return files.flat();
}

export async function findWorkspaceIsolationViolations() {
  const forbiddenRuntimeImports = [];
  const driverImporters = [];

  for (const filePath of await workspaceSourceFiles()) {
    const relativePath = path.relative(workspaceRoot, filePath).replaceAll('\\', '/');
    const contents = await readFile(filePath, 'utf8');
    const specifiers = importedModules(contents);

    for (const specifier of specifiers) {
      if (isForbiddenRuntimeModule(specifier)) {
        forbiddenRuntimeImports.push(`${relativePath} imports ${specifier}`);
      }
    }
    if (specifiers.includes(duckDbDriver)) driverImporters.push(relativePath);
  }

  const unexpectedDriverImporters = driverImporters
    .filter((importer) => !duckDbDriverModules.includes(importer))
    .sort();

  return { forbiddenRuntimeImports: forbiddenRuntimeImports.sort(), unexpectedDriverImporters };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { forbiddenRuntimeImports, unexpectedDriverImporters } =
    await findWorkspaceIsolationViolations();
  const failures = [...forbiddenRuntimeImports, ...unexpectedDriverImporters];
  if (failures.length > 0) {
    console.error('Shared workspace isolation violated:');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log('Shared workspace isolation checks passed.');
}
