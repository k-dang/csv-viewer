import { observeStage, retainDiagnosticContext } from '../workspace-diagnostics';
import { Deferred, Effect, Exit, Cause, Schema, SynchronizedRef, type Array as Arr, type Scope } from 'effect';
import { cleanupEffect } from './comparison-effects';
import type {
  ComparisonRow,
  ComparisonOperationId,
  ComparisonSummary,
  CsvColumn,
  SourceKeyDiagnostics,
  WorkingCsvId,
} from '../csv-viewer';
import { csvInternalRowIdField } from '../csv-viewer';
import type {
  ComparisonExecutor,
  ComparisonAttemptExecutor,
  CreateComparisonSnapshotRequest,
  ReadComparisonSnapshotWindowRequest,
  StoredComparisonWindow,
} from './comparison-executor';
import type { DataEngineError, WorkspaceDatabaseConnection } from '../database';

type ReaderLease = {
  readonly count: number;
  readonly drained: Deferred.Deferred<void>;
};

type ExecutorState = {
  readonly failedWorkers: ReadonlyMap<WorkspaceDatabaseConnection, Effect.Effect<void>>;
  readonly readers: ReadonlyMap<ComparisonOperationId, ReaderLease>;
  readonly snapshotReleases: ReadonlyMap<ComparisonOperationId, Effect.Effect<void, DataEngineError>>;
  readonly retirements: ReadonlyMap<ComparisonOperationId, Effect.Effect<void, DataEngineError>>;
};
import { WorkspaceRequestError } from '../errors';
import {
  buildDropTableSql,
  isValidRowWindow,
  quoteIdentifier,
  requireKnownColumn,
} from '../query/csv-query';
import {
  decodeEngineRow,
  decodeEngineRows,
  EngineCell,
  EngineNonNegativeInt,
  EngineRowId,
  normalizeCellValue,
} from '../query/csv-result-normalization';
import { csvDeletedField, csvSourceOrderField } from '../working-csv/csv-storage-schema';
import { WorkspaceArtifactRegistry } from '../workspace-artifact-registry';

const decodeCount = decodeEngineRow(Schema.Struct({ count: EngineNonNegativeInt }));
const decodeRowIdRows = decodeEngineRows(Schema.Struct({ row_id: EngineRowId }));
const ComparisonClassification = Schema.Literals(['changed', 'baseline-only', 'candidate-only', 'unchanged']);

/** Requires the engine columns `${prefix}_0` through `${prefix}_${count - 1}`, each decoded by `field`. */
function indexedColumns<P extends string, S extends Schema.Top>(prefix: P, count: number, field: S) {
  return {
    fields: Object.fromEntries(Array.from({ length: count }, (_value, index) => [`${prefix}_${index}`, field])),
    record: Schema.Record(Schema.TemplateLiteral([`${prefix}_`, Schema.Number]), field),
  };
}

export type ComparisonSource = {
  tableName: string;
  columns: CsvColumn[];
};

export type DuckDbComparisonAccess = {
  /** Leases a Working CSV's current table until the calling scope closes. */
  acquireSource(workingCsvId: WorkingCsvId): Effect.Effect<ComparisonSource, DataEngineError | WorkspaceRequestError, Scope.Scope>;
  getOwnerConnection(): Effect.Effect<WorkspaceDatabaseConnection, DataEngineError>;
  /** Admitted as workspace work, so disposal cannot close the database while it connects. */
  connectWorker(): Effect.Effect<WorkspaceDatabaseConnection, DataEngineError | WorkspaceRequestError>;
};

export class DuckDbComparisonExecutor implements ComparisonExecutor {
  private readonly state: SynchronizedRef.SynchronizedRef<ExecutorState>;

  constructor(
    private readonly database: DuckDbComparisonAccess,
    private readonly artifactRegistry = new WorkspaceArtifactRegistry(),
  ) {
    this.state = Effect.runSync(SynchronizedRef.make<ExecutorState>({
      failedWorkers: new Map(),
      readers: new Map(),
      snapshotReleases: new Map(),
      retirements: new Map(),
    }));
  }

  private get documents(): ExecutorState {
    return SynchronizedRef.getUnsafe(this.state);
  }

  private update(next: (state: ExecutorState) => ExecutorState): void {
    Effect.runSync(SynchronizedRef.update(this.state, next));
  }

  private modify<A>(next: (state: ExecutorState) => readonly [A, ExecutorState]): A {
    return Effect.runSync(SynchronizedRef.modify(this.state, (state) => {
      const [value, documents] = next(state);
      return [value, documents];
    }));
  }

  readonly openAttempt = Effect.fnUntraced(function* (
    this: DuckDbComparisonExecutor,
  ): Effect.fn.Return<ComparisonAttemptExecutor, DataEngineError | WorkspaceRequestError, Scope.Scope> {
    const writer = yield* Effect.acquireRelease(
      this.database.connectWorker(),
      (connection) => Effect.gen({ self: this }, function* () {
        const release = yield* retainDiagnosticContext(observeStage('comparison.release-worker', cleanupEffect(connection.close().pipe(
          Effect.tap(() => Effect.sync(() => this.update((state) => {
            if (!state.failedWorkers.has(connection)) return state;
            const failedWorkers = new Map(state.failedWorkers);
            failedWorkers.delete(connection);
            return { ...state, failedWorkers };
          }))),
        ))));
        this.update((state) => {
          const failedWorkers = new Map(state.failedWorkers);
          failedWorkers.set(connection, release);
          return { ...state, failedWorkers };
        });
        yield* release;
      }),
    );
    return {
      validateKey: (workingCsvId: WorkingCsvId, key: Arr.NonEmptyReadonlyArray<string>) => this.validateKey(writer, workingCsvId, key),
      createSnapshot: (request: CreateComparisonSnapshotRequest) => this.createSnapshot(writer, request),
    };
  });

  private readonly validateKey = Effect.fnUntraced(function* (
    this: DuckDbComparisonExecutor,
    writer: WorkspaceDatabaseConnection,
    workingCsvId: WorkingCsvId,
    key: Arr.NonEmptyReadonlyArray<string>,
  ): Effect.fn.Return<SourceKeyDiagnostics, DataEngineError | WorkspaceRequestError, Scope.Scope> {
    const source = yield* this.database.acquireSource(workingCsvId);
    const known = new Set(source.columns.map((column) => column.name));
    for (const column of key) yield* Effect.fromResult(requireKnownColumn(column, known));
    const table = quoteIdentifier(source.tableName);
    const active = `${quoteIdentifier(csvDeletedField)} = false`;
    const blank = key
      .map((column) => `(${quoteIdentifier(column)} IS NULL OR ${quoteIdentifier(column)} = '')`)
      .join(' OR ');
    const present = key
      .map(
        (column) =>
          `(${quoteIdentifier(column)} IS NOT NULL AND ${quoteIdentifier(column)} <> '')`,
      )
      .join(' AND ');
    const keyProjection = key
      .map((column, index) => `${quoteIdentifier(column)} AS ${quoteIdentifier(`key_${index}`)}`)
      .join(', ');
    const keyGroup = key.map(quoteIdentifier).join(', ');
    const keyOrder = key
      .map((column) => `${quoteIdentifier(column)} COLLATE "binary" ASC`)
      .join(', ');
    const keyCells = indexedColumns('key', key.length, EngineCell);
    const keyStrings = indexedColumns('key', key.length, Schema.String);
    const blankCount = yield* writer.readObjectsCancellable(
      `SELECT count(*)::BIGINT AS count FROM ${table} WHERE ${active} AND (${blank})`,
    ).pipe(Effect.flatMap(decodeCount));
    const blankExampleRows = yield* writer.readObjectsCancellable(
      `SELECT ${quoteIdentifier(csvInternalRowIdField)} AS row_id, ${keyProjection} FROM ${table}
       WHERE ${active} AND (${blank}) ORDER BY ${quoteIdentifier(csvSourceOrderField)} ASC LIMIT 5`,
    ).pipe(Effect.flatMap(decodeEngineRows(Schema.StructWithRest(
      Schema.Struct({ row_id: EngineRowId, ...keyCells.fields }),
      [keyCells.record],
    ))));
    const duplicateCount = yield* writer.readObjectsCancellable(
      `SELECT count(*)::BIGINT AS count FROM (
        SELECT 1 FROM ${table} WHERE ${active} AND (${present}) GROUP BY ${keyGroup} HAVING count(*) > 1
      ) duplicate_groups`,
    ).pipe(Effect.flatMap(decodeCount));
    const duplicateGroupRows = yield* writer.readObjectsCancellable(
      `SELECT ${keyProjection}, count(*)::BIGINT AS row_count FROM ${table} WHERE ${active} AND (${present})
       GROUP BY ${keyGroup} HAVING count(*) > 1 ORDER BY ${keyOrder} LIMIT 5`,
    ).pipe(Effect.flatMap(decodeEngineRows(Schema.StructWithRest(
      Schema.Struct({ row_count: EngineNonNegativeInt, ...keyStrings.fields }),
      [keyStrings.record],
    ))));
    const duplicateExamples: SourceKeyDiagnostics['duplicateExamples'] = [];
    for (const group of duplicateGroupRows) {
      const keyValues = key.map((_column, index) => group[`key_${index}`]);
      const conditions = key.map((column) => `${quoteIdentifier(column)} = ?`).join(' AND ');
      const rowIdRows = yield* writer.readObjectsCancellable(
        `SELECT ${quoteIdentifier(csvInternalRowIdField)} AS row_id FROM ${table}
         WHERE ${active} AND ${conditions} ORDER BY ${quoteIdentifier(csvSourceOrderField)} ASC LIMIT 5`,
        keyValues,
      ).pipe(Effect.flatMap(decodeRowIdRows));
      duplicateExamples.push({
        keyValues,
        rowCount: group.row_count,
        rowIds: rowIdRows.map((row) => row.row_id),
      });
    }

    return {
      blankRowCount: blankCount.count,
      duplicateGroupCount: duplicateCount.count,
      blankExamples: blankExampleRows.map((row) => ({
        rowId: row.row_id,
        keyValues: key.map((_column, index) => normalizeCellValue(row[`key_${index}`])),
      })),
      duplicateExamples,
    };
  }, (effect) => Effect.scoped(effect));

  private readonly createSnapshot = Effect.fnUntraced(function* (
    this: DuckDbComparisonExecutor,
    writer: WorkspaceDatabaseConnection,
    request: CreateComparisonSnapshotRequest,
  ): Effect.fn.Return<ComparisonSummary, DataEngineError | WorkspaceRequestError, Scope.Scope> {
    const baseline = yield* this.database.acquireSource(request.baselineId);
    const candidate = yield* this.database.acquireSource(request.candidateId);
    const tableName = buildComparisonTableName(request.artifactId);
    const table = quoteIdentifier(tableName);
    const join = request.key
      .map((column) => `b.${quoteIdentifier(column)} = c.${quoteIdentifier(column)}`)
      .join(' AND ');
    const anyChanged =
      request.valueColumns
        .map(
          (column) => `b.${quoteIdentifier(column)} IS DISTINCT FROM c.${quoteIdentifier(column)}`,
        )
        .join(' OR ') || 'false';
    const projection = [
      `CASE WHEN b.${quoteIdentifier(csvInternalRowIdField)} IS NULL THEN 'candidate-only' WHEN c.${quoteIdentifier(csvInternalRowIdField)} IS NULL THEN 'baseline-only' WHEN ${anyChanged} THEN 'changed' ELSE 'unchanged' END AS classification`,
      ...request.key.map(
        (column, index) =>
          `coalesce(b.${quoteIdentifier(column)}, c.${quoteIdentifier(column)}) AS ${quoteIdentifier(`key_${index}`)}`,
      ),
      `b.${quoteIdentifier(csvInternalRowIdField)} AS baseline_row_id`,
      `c.${quoteIdentifier(csvInternalRowIdField)} AS candidate_row_id`,
      `b.${quoteIdentifier(csvSourceOrderField)} AS baseline_order`,
      `c.${quoteIdentifier(csvSourceOrderField)} AS candidate_order`,
      ...request.valueColumns.flatMap((column, index) => [
        `b.${quoteIdentifier(column)} AS ${quoteIdentifier(`baseline_${index}`)}`,
        `c.${quoteIdentifier(column)} AS ${quoteIdentifier(`candidate_${index}`)}`,
        `(b.${quoteIdentifier(csvInternalRowIdField)} IS NOT NULL AND c.${quoteIdentifier(csvInternalRowIdField)} IS NOT NULL AND b.${quoteIdentifier(column)} IS DISTINCT FROM c.${quoteIdentifier(column)}) AS ${quoteIdentifier(`changed_${index}`)}`,
      ]),
    ].join(', ');

    const releaseSnapshot = yield* retainDiagnosticContext(
      observeStage('comparison.release-snapshot', this.retireSnapshot(request.artifactId)),
    );
    this.update((state) => {
      const snapshotReleases = new Map(state.snapshotReleases);
      snapshotReleases.set(request.artifactId, releaseSnapshot);
      return { ...state, snapshotReleases };
    });
    this.artifactRegistry.register({
      tableName,
      owner: { kind: 'comparison', comparisonId: request.comparisonId, operationId: request.artifactId },
      role: 'staging',
    });
    yield* writer.runCancellable(
      `CREATE TABLE ${table} AS SELECT ${projection}
       FROM (SELECT * FROM ${quoteIdentifier(baseline.tableName)} WHERE ${quoteIdentifier(csvDeletedField)} = false) b
       FULL OUTER JOIN (SELECT * FROM ${quoteIdentifier(candidate.tableName)} WHERE ${quoteIdentifier(csvDeletedField)} = false) c ON ${join}`,
    );
    const changedSums = request.valueColumns
      .map(
        (_column, index) =>
          `coalesce(sum(CASE WHEN ${quoteIdentifier(`changed_${index}`)} THEN 1 ELSE 0 END), 0)::BIGINT AS ${quoteIdentifier(`changed_count_${index}`)}`,
      )
      .join(', ');
    const changedCounts = indexedColumns('changed_count', request.valueColumns.length, EngineNonNegativeInt);
    const summary = yield* writer.readObjectsCancellable(
      `SELECT coalesce(sum(CASE WHEN classification = 'changed' THEN 1 ELSE 0 END), 0)::BIGINT AS changed,
        coalesce(sum(CASE WHEN classification = 'baseline-only' THEN 1 ELSE 0 END), 0)::BIGINT AS baseline_only,
        coalesce(sum(CASE WHEN classification = 'candidate-only' THEN 1 ELSE 0 END), 0)::BIGINT AS candidate_only,
        coalesce(sum(CASE WHEN classification = 'unchanged' THEN 1 ELSE 0 END), 0)::BIGINT AS unchanged,
        count(*)::BIGINT AS total${changedSums ? `, ${changedSums}` : ''} FROM ${table}`,
    ).pipe(Effect.flatMap(decodeEngineRow(Schema.StructWithRest(Schema.Struct({
      changed: EngineNonNegativeInt,
      baseline_only: EngineNonNegativeInt,
      candidate_only: EngineNonNegativeInt,
      unchanged: EngineNonNegativeInt,
      total: EngineNonNegativeInt,
      ...changedCounts.fields,
    }), [changedCounts.record]))));
    return {
      rows: {
        changed: summary.changed,
        baselineOnly: summary.baseline_only,
        candidateOnly: summary.candidate_only,
        unchanged: summary.unchanged,
        total: summary.total,
      },
      changedColumns: request.valueColumns.map((name, index) => ({
        name,
        changedRowCount: summary[`changed_count_${index}`],
      })),
    };
  }, (effect) => Effect.scoped(effect));

  activateSnapshot(artifactId: ComparisonOperationId): void {
    if (!this.hasSnapshot(artifactId) || this.documents.retirements.has(artifactId)) {
      throw new Error('Comparison staging snapshot is no longer available.');
    }
    this.artifactRegistry.transition(buildComparisonTableName(artifactId), 'active');
  }

  // Owner-connection queries cannot be cancelled. Keep the lease until they settle.
  readonly readWindow = Effect.fnUntraced(function* (
    this: DuckDbComparisonExecutor,
    request: ReadComparisonSnapshotWindowRequest,
  ): Effect.fn.Return<StoredComparisonWindow, DataEngineError | WorkspaceRequestError, Scope.Scope> {
    if (!isValidRowWindow(request.offset, request.limit)) {
      return yield* Effect.fail(new WorkspaceRequestError({
        message: 'Comparison window requires a non-negative offset and a limit of at most 1,000.',
      }));
    }
    yield* Effect.acquireRelease(
      this.acquireRead(request.artifactId),
      () => this.releaseRead(request.artifactId),
    );
    const connection = yield* this.database.getOwnerConnection();
    const table = quoteIdentifier(buildComparisonTableName(request.artifactId));
    const { where, parameters } = comparisonWhere(request);
    const order = comparisonOrder(request);
    const count = yield* connection.readObjects(
      `SELECT count(*)::BIGINT AS count FROM ${table}${where}`,
      parameters,
    ).pipe(Effect.flatMap(decodeCount));
    const keys = indexedColumns('key', request.keyCount, Schema.String);
    const baselineValues = indexedColumns('baseline', request.valueCount, EngineCell);
    const candidateValues = indexedColumns('candidate', request.valueCount, EngineCell);
    const changed = indexedColumns('changed', request.valueCount, Schema.Boolean);
    const resultRows = yield* connection.readObjects(
      `SELECT * FROM ${table}${where} ORDER BY ${order} LIMIT ${request.limit} OFFSET ${request.offset}`,
      parameters,
    ).pipe(Effect.flatMap(decodeEngineRows(Schema.StructWithRest(Schema.Struct({
      classification: ComparisonClassification,
      baseline_row_id: Schema.NullOr(EngineRowId),
      candidate_row_id: Schema.NullOr(EngineRowId),
      ...keys.fields,
      ...baselineValues.fields,
      ...candidateValues.fields,
      ...changed.fields,
    }), [keys.record, baselineValues.record, candidateValues.record, changed.record]))));
    const columnIndexes = Array.from({ length: request.valueCount }, (_value, index) => index);
    const rows = resultRows.map((row): ComparisonRow => {
      const classification = row.classification;
      const baselineSide =
        row.baseline_row_id === null
          ? null
          : {
              rowId: row.baseline_row_id,
              values: columnIndexes.map((index) =>
                normalizeCellValue(row[`baseline_${index}`]),
              ),
            };
      const candidateSide =
        row.candidate_row_id === null
          ? null
          : {
              rowId: row.candidate_row_id,
              values: columnIndexes.map((index) =>
                normalizeCellValue(row[`candidate_${index}`]),
              ),
            };
      return {
        classification: request.swapped ? flipClassification(classification) : classification,
        keyValues: Array.from({ length: request.keyCount }, (_value, index) => row[`key_${index}`]),
        baseline: request.swapped ? candidateSide : baselineSide,
        candidate: request.swapped ? baselineSide : candidateSide,
        changed: columnIndexes.map((index) => row[`changed_${index}`]),
      };
    });
    return { totalRowCount: count.count, rows };
  }, Effect.scoped, Effect.uninterruptible);

  // A shared retirement must finish waiting and dropping even if a caller is interrupted.
  readonly dropSnapshot = Effect.fnUntraced(function* (
    this: DuckDbComparisonExecutor,
    artifactId: ComparisonOperationId,
  ): Effect.fn.Return<void, DataEngineError> {
    const existing = this.documents.retirements.get(artifactId);
    if (existing) return yield* existing;
    if (!this.hasSnapshot(artifactId)) return;
    const release = this.documents.snapshotReleases.get(artifactId);
    if (!release) return yield* Effect.die(new Error('Comparison snapshot release is missing.'));
    const retirement = yield* Effect.cached(release.pipe(
      Effect.ensuring(Effect.sync(() => this.update((state) => {
        if (!state.retirements.has(artifactId)) return state;
        const retirements = new Map(state.retirements);
        retirements.delete(artifactId);
        return { ...state, retirements };
      }))),
    ));
    this.update((state) => {
      const retirements = new Map(state.retirements);
      retirements.set(artifactId, retirement);
      return { ...state, retirements };
    });
    yield* retirement;
  }, Effect.uninterruptible);

  // Attempt all independent cleanup before reporting disposal failure.
  readonly dispose = Effect.fnUntraced(function* (
    this: DuckDbComparisonExecutor,
  ): Effect.fn.Return<void, DataEngineError> {
    const failures: Cause.Cause<DataEngineError>[] = [];
    for (const release of [...this.documents.failedWorkers.values()]) {
      const result = yield* Effect.exit(release);
      if (Exit.isFailure(result)) failures.push(result.cause);
    }
    for (const artifact of this.artifactRegistry.list()) {
      if (artifact.owner.kind !== 'comparison') continue;
      const result = yield* Effect.exit(this.dropSnapshot(artifact.owner.operationId));
      if (Exit.isFailure(result)) failures.push(result.cause);
    }
    if (failures.length > 0) {
      return yield* Effect.failCause(failures.reduce((combined, cause) => Cause.combine(combined, cause), Cause.empty));
    }
    this.artifactRegistry.assertNoArtifactsOwnedBy('comparison');
  }, Effect.uninterruptible);

  private readonly acquireRead = Effect.fnUntraced(function* (
    this: DuckDbComparisonExecutor,
    artifactId: ComparisonOperationId,
  ): Effect.fn.Return<void, WorkspaceRequestError> {
    const drained = yield* Deferred.make<void>();
    // The check and the increment are one synchronous update. A retirement that
    // starts after this returns sees the lease and waits for it to drain.
    const admitted = this.modify((state) => {
      if (!this.hasSnapshot(artifactId) || state.retirements.has(artifactId)) return [false, state] as const;
      const readers = new Map(state.readers);
      const current = readers.get(artifactId);
      if (current) readers.set(artifactId, { count: current.count + 1, drained: current.drained });
      else readers.set(artifactId, { count: 1, drained });
      return [true, { ...state, readers }] as const;
    });
    if (!admitted) {
      return yield* Effect.fail(new WorkspaceRequestError({ message: 'Comparison snapshot is no longer available.' }));
    }
  });

  private readonly releaseRead = Effect.fnUntraced(function* (
    this: DuckDbComparisonExecutor,
    artifactId: ComparisonOperationId,
  ): Effect.fn.Return<void> {
    const drained = this.modify((state) => {
      const current = state.readers.get(artifactId);
      if (!current) return [undefined, state] as const;
      const readers = new Map(state.readers);
      if (current.count > 1) {
        readers.set(artifactId, { count: current.count - 1, drained: current.drained });
        return [null, { ...state, readers }] as const;
      }
      readers.delete(artifactId);
      return [current.drained, { ...state, readers }] as const;
    });
    if (drained === undefined) return yield* Effect.die(new Error('Comparison reader lease is missing.'));
    if (drained) yield* Deferred.succeed(drained, undefined);
  });

  private waitForReaders(artifactId: ComparisonOperationId): Effect.Effect<void> {
    return Effect.suspend(() => {
      const readers = this.documents.readers.get(artifactId);
      return readers ? Deferred.await(readers.drained) : Effect.void;
    });
  }

  private readonly retireSnapshot = Effect.fnUntraced(function* (
    this: DuckDbComparisonExecutor,
    artifactId: ComparisonOperationId,
  ): Effect.fn.Return<void, DataEngineError> {
    const tableName = buildComparisonTableName(artifactId);
    this.artifactRegistry.transition(tableName, 'retired');
    yield* this.waitForReaders(artifactId);
    const connection = yield* this.database.getOwnerConnection();
    yield* connection.run(buildDropTableSql(tableName));
    this.artifactRegistry.remove(tableName);
    this.update((state) => {
      if (!state.snapshotReleases.has(artifactId)) return state;
      const snapshotReleases = new Map(state.snapshotReleases);
      snapshotReleases.delete(artifactId);
      return { ...state, snapshotReleases };
    });
  });

  private hasSnapshot(artifactId: ComparisonOperationId): boolean {
    return this.artifactRegistry.get(buildComparisonTableName(artifactId)) !== null;
  }
}

function buildComparisonTableName(artifactId: ComparisonOperationId): string {
  return `csv_comparison_${artifactId.replaceAll('-', '_')}`;
}

function flipClassification(
  classification: ComparisonRow['classification'],
): ComparisonRow['classification'] {
  if (classification === 'baseline-only') return 'candidate-only';
  if (classification === 'candidate-only') return 'baseline-only';
  return classification;
}

/** Search keys and values on both sides, using literal substring matching and bound parameters. */
function comparisonWhere(request: ReadComparisonSnapshotWindowRequest) {
  const conditions: string[] = [];
  const parameters: string[] = [];
  if (request.rows === 'differences') conditions.push("classification <> 'unchanged'");
  else if (request.rows !== 'all') {
    conditions.push('classification = ?');
    parameters.push(request.swapped ? flipClassification(request.rows) : request.rows);
  }
  if (request.search) {
    const fields = [
      ...Array.from({ length: request.keyCount }, (_value, index) => `key_${index}`),
      ...Array.from({ length: request.valueCount }, (_value, index) => [`baseline_${index}`, `candidate_${index}`]).flat(),
    ];
    conditions.push(`(${fields.map((field) => {
      parameters.push(request.search);
      return `contains(lower(coalesce(CAST(${quoteIdentifier(field)} AS VARCHAR), '')), lower(?))`;
    }).join(' OR ')})`);
  }
  return { where: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '', parameters };
}

/** CSV order follows the current Baseline, then appends Candidate-only rows in Candidate order. */
function comparisonOrder(request: ReadComparisonSnapshotWindowRequest): string {
  const baseline = request.swapped ? 'candidate_order' : 'baseline_order';
  const candidate = request.swapped ? 'baseline_order' : 'candidate_order';
  const csvOrder = `${baseline} ASC NULLS LAST, ${candidate} ASC NULLS LAST`;
  if (request.order === 'csv-order') return csvOrder;
  const baselineOnly = request.swapped ? 'candidate-only' : 'baseline-only';
  return `CASE classification WHEN 'changed' THEN 0 WHEN '${baselineOnly}' THEN 1 WHEN 'unchanged' THEN 3 ELSE 2 END, ${csvOrder}`;
}
