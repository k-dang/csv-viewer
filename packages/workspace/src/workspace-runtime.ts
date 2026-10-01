import { diagnosticsLayer, observeStage, type WorkspaceDiagnostics } from './workspace-diagnostics';
import { Context, Effect, Exit, Layer } from 'effect';
import { ComparisonExecutor } from './comparison/comparison-executor';
import { CsvComparisonService } from './comparison/csv-comparison-service';
import type { DataEngineError, OwnedWorkspaceDatabase } from './database';
import { WorkingCsvStore } from './working-csv/working-csv-store';
import type { CsvWorkspaceHost } from './workspace-host';

export const Host = Context.Service<CsvWorkspaceHost>('csv-viewer/Host');
const Database = Context.Service<OwnedWorkspaceDatabase>('csv-viewer/Database');
export const WorkingCsv = Context.Service<WorkingCsvStore>('csv-viewer/WorkingCsv');
export const Comparisons = Context.Service<CsvComparisonService>('csv-viewer/Comparisons');

/**
 * One runtime per workspace, read top to bottom in acquisition order: the database and the host,
 * then the Working CSV and Comparison services built on both. Disposal settles Comparison work and
 * releases Working CSV tables before closing the layer scope, which releases the database. The
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
  const databaseRelease = { failed: false };
  const database = Layer.effect(Database, Effect.acquireRelease(
    observeStage('workspace.acquire-database', openDatabase),
    (acquired) => releaseDatabase(acquired).pipe(Effect.catchCause(() => Effect.sync(() => {
      databaseRelease.failed = true;
    }))),
    { interruptible: true },
  ).pipe(Effect.tap(() => startupCheck ? observeStage('web.startup-check', startupCheck) : Effect.void)));
  const resources = Layer.mergeAll(database, Layer.succeed(Host, host));
  const csvs = Layer.effect(WorkingCsv, Effect.gen(function* () {
    return new WorkingCsvStore(yield* Host, yield* Database);
  })).pipe(Layer.provideMerge(resources));
  const execution = executor
    ? Layer.succeed(ComparisonExecutor, executor)
    : Layer.effect(ComparisonExecutor, Effect.gen(function* () {
        return (yield* WorkingCsv).createComparisonExecutor();
      }));
  const comparisons = Layer.effect(Comparisons, Effect.gen(function* () {
    return new CsvComparisonService(yield* WorkingCsv, yield* ComparisonExecutor, yield* Effect.scope);
  })).pipe(Layer.provide(execution), Layer.provideMerge(csvs));
  return { layer: comparisons.pipe(Layer.provideMerge(diagnosticsLayer(diagnostics))), databaseRelease };
}

/** Closes the owner connection, then the engine even if that failed. Each failed step is its own stage. */
function releaseDatabase(database: OwnedWorkspaceDatabase) {
  return observeStage('workspace.release-database', Effect.gen(function* () {
    const connection = yield* Effect.exit(observeStage('workspace.close-database-connection', database.closeOwnerConnection()));
    const engine = yield* Effect.exit(observeStage('workspace.close-database-engine', database.closeEngine()));
    yield* Exit.asVoidAll([connection, engine]);
  }));
}
