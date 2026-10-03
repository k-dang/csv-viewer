import type { Effect } from 'effect';
import { expectTypeOf } from 'vitest';
import type { ComparisonCleanupError } from './comparison/comparison-effects';
import type { DataEngineError } from './database';
import type { WorkspaceRequestError } from './errors';
import type { WorkingCsvs } from './working-csv/working-csv-store';
import type { CsvSourceUnavailableError } from './workspace-host';

// Compile-time contracts, enforced by the repository typecheck.

// An ordinary Error cannot stand in for a declared failure.
expectTypeOf<Error>().not.toExtend<DataEngineError>();
expectTypeOf<Error>().not.toExtend<CsvSourceUnavailableError>();
expectTypeOf<Error>().not.toExtend<ComparisonCleanupError>();

// A Comparison cleanup failure is a defect, never an expected engine failure.
expectTypeOf<ComparisonCleanupError>().not.toExtend<DataEngineError>();

// Export names every declared failure it can end with, and no others.
expectTypeOf<Effect.Error<ReturnType<WorkingCsvs['exportCsv']>>>()
  .toEqualTypeOf<WorkspaceRequestError | DataEngineError | CsvSourceUnavailableError>();
