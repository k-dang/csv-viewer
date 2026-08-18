import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * The shared workspace runs in the Electron main process today and in a browser page once the web
 * runtime lands, so it must not reach for Electron or Node filesystem primitives, must not import
 * from a runtime-specific tree such as src/main, and the native DuckDB driver must stay in the
 * named database modules the web adapter will sit beside.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.join(repoRoot, 'src', 'workspace');
/** The only source trees a workspace module may reach into: itself and the shared contracts. */
const reachableRoots = [workspaceRoot, path.join(repoRoot, 'src', 'shared')];
const duckDbDriver = '@duckdb/node-api';
const duckDbDriverModules = ['duckdb/duckdb-comparison-executor.ts', 'duckdb/duckdb-database.ts'];
/** Package roots, so every subpath of one - `electron/main`, `node:fs/promises` - is caught too. */
const runtimeModuleRoots = ['electron', 'fs', 'path', 'os', 'child_process', 'worker_threads'];

/**
 * Static imports, `export ... from`, dynamic `import()`, and bare `import 'x'`. The real parser
 * does this without the false positives a regex scanner hits inside comments and string literals.
 */
function importedModules(contents) {
  return ts.preProcessFile(contents, true, true).importedFiles.map((file) => file.fileName);
}

export function isForbiddenRuntimeModule(specifier) {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return runtimeModuleRoots.includes(bare.split('/')[0]);
}

/** True when a relative import escapes the workspace into a runtime-specific tree such as src/main. */
function escapesWorkspace(specifier, fromFile) {
  if (!specifier.startsWith('.')) return false;
  const target = path.resolve(path.dirname(fromFile), specifier);
  return !reachableRoots.some(
    (root) => target === root || target.startsWith(`${root}${path.sep}`),
  );
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
  const crossLayerImports = [];
  const driverImporters = [];

  for (const filePath of await workspaceSourceFiles()) {
    const relativePath = path.relative(workspaceRoot, filePath).replaceAll('\\', '/');
    const contents = await readFile(filePath, 'utf8');
    const specifiers = importedModules(contents);

    for (const specifier of specifiers) {
      if (isForbiddenRuntimeModule(specifier)) {
        forbiddenRuntimeImports.push(`${relativePath} imports ${specifier}`);
      }
      if (escapesWorkspace(specifier, filePath)) {
        crossLayerImports.push(`${relativePath} imports ${specifier}`);
      }
    }
    if (specifiers.includes(duckDbDriver)) driverImporters.push(relativePath);
  }

  const unexpectedDriverImporters = driverImporters
    .filter((importer) => !duckDbDriverModules.includes(importer))
    .sort();

  return {
    forbiddenRuntimeImports: forbiddenRuntimeImports.sort(),
    crossLayerImports: crossLayerImports.sort(),
    unexpectedDriverImporters,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { forbiddenRuntimeImports, crossLayerImports, unexpectedDriverImporters } =
    await findWorkspaceIsolationViolations();
  const failures = [...forbiddenRuntimeImports, ...crossLayerImports, ...unexpectedDriverImporters];
  if (failures.length > 0) {
    console.error('Shared workspace isolation violated:');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log('Shared workspace isolation checks passed.');
}
