import { diagnosticsLayer, type WorkspaceDiagnostics } from './workspace-diagnostics';
import { Context, Effect, Layer, ManagedRuntime } from 'effect';
import { ComparisonExecutor } from './comparison/comparison-executor';
import { CsvComparisonService } from './comparison/csv-comparison-service';
import type { WorkspaceDatabase } from './database';
import { WorkingCsvStore } from './working-csv/working-csv-store';
import type { CsvWorkspaceHost } from './workspace-host';

const Host = Context.Service<CsvWorkspaceHost>('csv-viewer/Host');
const Database = Context.Service<WorkspaceDatabase>('csv-viewer/Database');
export const WorkingCsv = Context.Service<WorkingCsvStore>('csv-viewer/WorkingCsv');
export const Comparisons = Context.Service<CsvComparisonService>('csv-viewer/Comparisons');

/** One runtime per workspace. The layer scope owns background attempts, not their resources. */
export function makeWorkspaceRuntime(
  host: CsvWorkspaceHost,
  database: WorkspaceDatabase,
  executor?: ComparisonExecutor,
  diagnostics?: WorkspaceDiagnostics,
) {
  const csvs = Layer.effect(WorkingCsv, Effect.gen(function* () {
    return new WorkingCsvStore(yield* Host, yield* Database);
  })).pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Host, host), Layer.succeed(Database, database))));
  const execution = executor
    ? Layer.succeed(ComparisonExecutor, executor)
    : Layer.effect(ComparisonExecutor, Effect.gen(function* () {
        return (yield* WorkingCsv).createComparisonExecutor();
      }));
  const comparisons = Layer.effect(Comparisons, Effect.gen(function* () {
    return new CsvComparisonService(yield* WorkingCsv, yield* ComparisonExecutor, yield* Effect.scope);
  })).pipe(Layer.provide(execution), Layer.provideMerge(csvs));
  return ManagedRuntime.make(comparisons.pipe(Layer.provideMerge(diagnosticsLayer(diagnostics))));
}
