import { diagnosticsLayer, type WorkspaceDiagnostics } from './workspace-diagnostics';
import { Layer } from 'effect';
import { ComparisonExecutor } from './comparison/comparison-executor';
import { comparisonsLayer } from './comparison/csv-comparison-service';
import { workspaceDatabaseLayer, type OpenWorkspaceDatabase } from './database';
import { workingCsvsLayer } from './working-csv/working-csv-store';
import { CsvWorkspaceHost } from './workspace-host';

/**
 * One runtime per workspace, read top to bottom in acquisition order: the database and the host,
 * then the Working CSV and Comparison services built on both. Disposal settles Comparison work and
 * releases Working CSV resources before closing the layer scope, which releases the database. The
 * scope also owns background Comparison attempts, not their resources.
 */
export function makeWorkspaceLayer(
  openDatabase: OpenWorkspaceDatabase,
  host: CsvWorkspaceHost,
  executor?: ComparisonExecutor,
  diagnostics?: WorkspaceDiagnostics,
) {
  const csvs = workingCsvsLayer.pipe(Layer.provideMerge(Layer.mergeAll(workspaceDatabaseLayer(openDatabase), Layer.succeed(CsvWorkspaceHost, host))));
  // A test executor stands in for the Working CSVs' DuckDB executor.
  const executed = executor ? comparisonsLayer.pipe(Layer.provide(Layer.succeed(ComparisonExecutor, executor))) : comparisonsLayer;
  const comparisons = executed.pipe(Layer.provideMerge(csvs));
  return comparisons.pipe(Layer.provideMerge(diagnosticsLayer(diagnostics)));
}
