import { diagnosticsLayer, observeStage, type WorkspaceDiagnostics } from './workspace-diagnostics';
import { Effect, Layer } from 'effect';
import { ComparisonExecutor } from './comparison/comparison-executor';
import { comparisonsLayer } from './comparison/csv-comparison-service';
import { workspaceDatabaseLayer, type DataEngineError, type OwnedWorkspaceDatabase } from './database';
import { workingCsvsLayer } from './working-csv/working-csv-store';
import { CsvWorkspaceHost } from './workspace-host';

/**
 * One runtime per workspace, read top to bottom in acquisition order: the database and the host,
 * then the Working CSV and Comparison services built on both. Disposal settles Comparison work and
 * releases Working CSV resources before closing the layer scope, which releases the database. The
 * scope also owns background Comparison attempts, not their resources.
 * Finalizers cannot fail, so `databaseRelease` tells disposal whether the database released.
 */
export function makeWorkspaceLayer(
  openDatabase: Effect.Effect<OwnedWorkspaceDatabase, DataEngineError>,
  host: CsvWorkspaceHost,
  executor?: ComparisonExecutor,
  diagnostics?: WorkspaceDiagnostics,
  startupCheck?: Effect.Effect<void, DataEngineError>,
) {
  const database = workspaceDatabaseLayer(openDatabase);
  const checkedDatabase = startupCheck
    ? database.layer.pipe(Layer.tap(() => observeStage('web.startup-check', startupCheck)))
    : database.layer;
  const csvs = workingCsvsLayer.pipe(Layer.provideMerge(Layer.mergeAll(checkedDatabase, Layer.succeed(CsvWorkspaceHost, host))));
  // A test executor stands in for the Working CSVs' DuckDB executor.
  const executed = executor ? comparisonsLayer.pipe(Layer.provide(Layer.succeed(ComparisonExecutor, executor))) : comparisonsLayer;
  const comparisons = executed.pipe(Layer.provideMerge(csvs));
  return { layer: comparisons.pipe(Layer.provideMerge(diagnosticsLayer(diagnostics))), databaseRelease: database.release };
}
