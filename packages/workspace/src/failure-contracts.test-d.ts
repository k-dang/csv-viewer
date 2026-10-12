import type { Effect } from 'effect';
import { expectTypeOf } from 'vitest';
import type { ComparisonCleanupError } from './comparison/comparison-effects';
import type { DataEngineError } from './database';
import type { CsvOpenError, WorkspaceRequestError } from './errors';
import type { WorkingCsvs } from './working-csv/working-csv-store';
import type { CsvSourceUnavailableError } from './workspace-host';

// Compile-time contracts, enforced by the repository typecheck.

// An ordinary Error cannot stand in for a declared failure.
expectTypeOf<Error>().not.toExtend<DataEngineError>();
expectTypeOf<Error>().not.toExtend<CsvSourceUnavailableError>();
expectTypeOf<Error>().not.toExtend<ComparisonCleanupError>();
expectTypeOf<Error>().not.toExtend<CsvOpenError>();

// An open failure is its own tag, so it cannot be mistaken for a plain request rejection.
expectTypeOf<CsvOpenError>().not.toExtend<WorkspaceRequestError>();

// A Comparison cleanup failure is a defect, never an expected engine failure.
expectTypeOf<ComparisonCleanupError>().not.toExtend<DataEngineError>();

// Export names every declared failure it can end with, and no others.
expectTypeOf<Effect.Error<ReturnType<WorkingCsvs['exportCsv']>>>()
  .toEqualTypeOf<WorkspaceRequestError | DataEngineError | CsvSourceUnavailableError>();

// Opening names its own failure tag beside plain request rejections.
expectTypeOf<Effect.Error<ReturnType<WorkingCsvs['open']>>>()
  .toEqualTypeOf<WorkspaceRequestError | CsvOpenError>();
