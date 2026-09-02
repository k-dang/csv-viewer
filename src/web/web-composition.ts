import { quoteLiteral } from '../workspace/csv-query';
import { createCsvViewer, type CsvWorkspaceOwner } from '../workspace/csv-workspace';
import { DuckDbWasmWorkspaceDatabase } from '../workspace/duckdb/duckdb-wasm-database';
import type { WebCsvFilePicker } from './web-workspace-host';
import { WebWorkspaceHost } from './web-workspace-host';

export type WebCsvViewerStartup =
  | { status: 'ready'; viewer: CsvWorkspaceOwner }
  | { status: 'unsupported' };

/** Starts the pinned Worker and proves its in-memory CSV path before file selection is enabled. */
export async function startWebCsvViewer(
  database: DuckDbWasmWorkspaceDatabase,
  pickFile: WebCsvFilePicker,
): Promise<WebCsvViewerStartup> {
  try {
    await verifyRequiredWasmFeatures(database);
    return {
      status: 'ready',
      viewer: createCsvViewer(new WebWorkspaceHost(database, pickFile), database),
    };
  } catch (error) {
    console.error('CSV Viewer Web startup check failed.', error);
    const failures = await database.close();
    failures.forEach((failure) => console.error('CSV Viewer Web cleanup failed.', failure));
    return { status: 'unsupported' };
  }
}

async function verifyRequiredWasmFeatures(database: DuckDbWasmWorkspaceDatabase): Promise<void> {
  // Encoded per call: registering hands the buffer to the Worker, which may detach it.
  const probe = new TextEncoder().encode('ready\ntrue\n');
  const rows = await database.withRegisteredFile('startup-check.csv', probe, (reference) =>
    database.readObjects(
      `SELECT ready FROM read_csv_auto(${quoteLiteral(reference)}, all_varchar = true, header = true)`,
    ),
  );
  if (rows.length !== 1 || rows[0]?.ready !== 'true') {
    throw new Error('The browser could not run the required in-memory CSV query.');
  }
}
