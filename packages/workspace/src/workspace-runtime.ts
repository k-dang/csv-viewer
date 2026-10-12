import { diagnosticsLayer, observeStage, type WorkspaceDiagnostics } from './workspace-diagnostics';
import { Context, Deferred, Effect, Layer } from 'effect';
import { ComparisonExecutor } from './comparison/comparison-executor';
import { Comparisons, comparisonsLayer } from './comparison/csv-comparison-service';
import { workspaceDatabaseLayer, type OpenWorkspaceDatabase } from './database';
import { duckDbComparisonExecutorLayer, WorkingCsvs, workingCsvsLayer } from './working-csv/working-csv-store';
import { CsvWorkspaceHost } from './workspace-host';

/**
 * One runtime per workspace, read top to bottom in acquisition order: the database and the host,
 * then the Working CSV and Comparison services built on both. Each release Layer sits directly on
 * the service it releases, so closing the runtime settles Comparisons before their attempt scope
 * closes, then releases Working CSV tables, then the database. After `stopped` completes the
 * engine has taken its tables with it, so the releases settle state without querying it.
 */
export function makeWorkspaceLayer(
  openDatabase: OpenWorkspaceDatabase,
  host: CsvWorkspaceHost,
  executor?: ComparisonExecutor,
  diagnostics?: WorkspaceDiagnostics,
  stopped?: Deferred.Deferred<void>,
) {
  const engineStopped = Effect.sync(() => stopped !== undefined && Deferred.isDoneUnsafe(stopped));
  const resources = Layer.mergeAll(workspaceDatabaseLayer(openDatabase), Layer.succeed(CsvWorkspaceHost, host));
  const csvs = releaseOnClose(WorkingCsvs, (csvs) => engineStopped.pipe(Effect.flatMap((stopped) => stopped
    ? Effect.sync(() => csvs.releaseSourcesAfterEngineStop())
    : observeStage('workspace.release-csvs', csvs.disposeStore())))).pipe(Layer.provideMerge(workingCsvsLayer), Layer.provideMerge(resources));
  const executorLayer = executor ? Layer.succeed(ComparisonExecutor, executor) : duckDbComparisonExecutorLayer;
  const comparisons = releaseOnClose(Comparisons, (comparisons) => engineStopped.pipe(Effect.flatMap((stopped) => stopped
    ? observeStage('comparison.stop', comparisons.stopAfterEngineStop())
    : observeStage('comparison.dispose', comparisons.dispose())))).pipe(Layer.provideMerge(comparisonsLayer.pipe(Layer.provide(executorLayer))), Layer.provideMerge(csvs));
  return comparisons.pipe(Layer.provideMerge(diagnosticsLayer(diagnostics)));
}

/**
 * Releases a service when the runtime closes, before the scope of the Layer that built it. The
 * release runs in the closing fiber, so its stages report under the disposal request.
 */
function releaseOnClose<I, S, E>(service: Context.Service<I, S>, release: (service: S) => Effect.Effect<void, E>) {
  return Layer.effectDiscard(service.use((value) => Effect.addFinalizer(() =>
    // SAFETY: Scope close runs every finalizer and fails with their combined causes, so the typed
    // failure reaches the disposal caller although finalizer types are infallible.
    release(value) as Effect.Effect<void>)));
}
