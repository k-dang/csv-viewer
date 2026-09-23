import { observeStage, recordOutcome, retainDiagnosticContext } from '../workspace-diagnostics';
import { Deferred, Effect, Exit, Cause, type Scope } from 'effect';
import { ComparisonCleanup, cleanupEffect, comparisonQuery, databaseEffect } from './comparison-effects';
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
import { DataEngineError, type WorkspaceDatabaseConnection } from '../database';
import {
  assertKnownColumn,
  buildDropTableSql,
  isValidRowWindow,
  quoteIdentifier,
} from '../query/csv-query';
import { normalizeCellValue, normalizeCount, type EngineCellValue } from '../query/csv-result-normalization';
import { csvDeletedField, csvSourceOrderField } from '../working-csv/csv-storage-schema';
import { WorkspaceArtifactRegistry } from '../workspace-artifact-registry';

export type ComparisonSource = {
  tableName: string;
  columns: CsvColumn[];
  release(): Promise<void | DataEngineError>;
};

export type DuckDbComparisonAccess = {
  acquireSource(workingCsvId: WorkingCsvId): Promise<ComparisonSource>;
  getOwnerConnection(): Promise<WorkspaceDatabaseConnection>;
  connectWorker(): Promise<WorkspaceDatabaseConnection>;
};

export class DuckDbComparisonExecutor implements ComparisonExecutor {
  private readonly failedWorkers = new Map<WorkspaceDatabaseConnection, Effect.Effect<void>>();
  private readonly failedSources = new Map<ComparisonSource, Effect.Effect<void>>();
  private readonly readers = new Map<ComparisonOperationId, {
    count: number;
    drained: Deferred.Deferred<void>;
  }>();
  private readonly snapshotReleases = new Map<ComparisonOperationId, Effect.Effect<void, DataEngineError>>();
  private readonly retirements = new Map<ComparisonOperationId, Effect.Effect<void, DataEngineError>>();

  constructor(
    private readonly database: DuckDbComparisonAccess,
    private readonly artifactRegistry = new WorkspaceArtifactRegistry(),
  ) {}

  readonly openAttempt = Effect.fnUntraced(function* (
    this: DuckDbComparisonExecutor,
  ): Effect.fn.Return<ComparisonAttemptExecutor, DataEngineError, Scope.Scope> {
    const writer = yield* Effect.acquireRelease(
      databaseEffect(() => this.database.connectWorker()),
      (connection) => Effect.gen({ self: this }, function* () {
        const release = yield* retainDiagnosticContext(observeStage('comparison.release-worker', cleanupEffect(async () => {
          await connection.close();
          this.failedWorkers.delete(connection);
        })));
        this.failedWorkers.set(connection, release);
        yield* release;
      }),
    );
    return {
      validateKey: (workingCsvId: WorkingCsvId, key: string[]) => this.validateKey(writer, workingCsvId, key),
      createSnapshot: (request: CreateComparisonSnapshotRequest) => this.createSnapshot(writer, request),
    };
  });

  private acquireSource(workingCsvId: WorkingCsvId) {
    return Effect.acquireRelease(
      databaseEffect(() => this.database.acquireSource(workingCsvId)),
      (source) => Effect.gen({ self: this }, function* () {
        const release = yield* retainDiagnosticContext(observeStage('comparison.release-source', Effect.gen({ self: this }, function* () {
          const deferredCleanup = yield* cleanupEffect(() => source.release());
          this.failedSources.delete(source);
          if (deferredCleanup) {
            const cleanup = yield* Effect.serviceOption(ComparisonCleanup);
            if (cleanup._tag === 'Some') cleanup.value.failed = true;
            yield* recordOutcome('cleanup-failed', Cause.fail(deferredCleanup));
          }
        })).pipe(Effect.annotateSpans({ workingCsvId })));
        this.failedSources.set(source, release);
        yield* release;
      }),
    );
  }

  private readonly validateKey = Effect.fnUntraced(function* (
    this: DuckDbComparisonExecutor,
    writer: WorkspaceDatabaseConnection,
    workingCsvId: WorkingCsvId,
    key: string[],
  ): Effect.fn.Return<SourceKeyDiagnostics, DataEngineError, Scope.Scope> {
    if (key.length === 0) throw new Error('Comparison key requires at least one column.');
    const source = yield* this.acquireSource(workingCsvId);
    const known = new Set(source.columns.map((column) => column.name));
    key.forEach((column) => assertKnownColumn(column, known));
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
    const blankCountRows = yield* comparisonQuery(writer, () => writer.readObjectsCancellable(
      `SELECT count(*)::BIGINT AS count FROM ${table} WHERE ${active} AND (${blank})`,
    ));
    const blankExampleRows = yield* comparisonQuery(writer, () => writer.readObjectsCancellable(
      `SELECT ${quoteIdentifier(csvInternalRowIdField)} AS row_id, ${keyProjection} FROM ${table}
       WHERE ${active} AND (${blank}) ORDER BY ${quoteIdentifier(csvSourceOrderField)} ASC LIMIT 5`,
    ));
    const duplicateCountRows = yield* comparisonQuery(writer, () => writer.readObjectsCancellable(
      `SELECT count(*)::BIGINT AS count FROM (
        SELECT 1 FROM ${table} WHERE ${active} AND (${present}) GROUP BY ${keyGroup} HAVING count(*) > 1
      ) duplicate_groups`,
    ));
    const duplicateGroupRows = yield* comparisonQuery(writer, () => writer.readObjectsCancellable(
      `SELECT ${keyProjection}, count(*)::BIGINT AS row_count FROM ${table} WHERE ${active} AND (${present})
       GROUP BY ${keyGroup} HAVING count(*) > 1 ORDER BY ${keyOrder} LIMIT 5`,
    ));
    const duplicateExamples: SourceKeyDiagnostics['duplicateExamples'] = [];
    for (const group of duplicateGroupRows) {
      const keyValues = key.map((_column, index) => String(group[`key_${index}`]));
      const conditions = key.map((column) => `${quoteIdentifier(column)} = ?`).join(' AND ');
      const rowIdRows = yield* comparisonQuery(writer, () => writer.readObjectsCancellable(
        `SELECT ${quoteIdentifier(csvInternalRowIdField)} AS row_id FROM ${table}
         WHERE ${active} AND ${conditions} ORDER BY ${quoteIdentifier(csvSourceOrderField)} ASC LIMIT 5`,
        keyValues,
      ));
      duplicateExamples.push({
        keyValues,
        rowCount: normalizeCount(group.row_count),
        rowIds: rowIdRows.map((row) => String(row.row_id)),
      });
    }

    return {
      blankRowCount: normalizeCount(blankCountRows[0].count),
      duplicateGroupCount: normalizeCount(duplicateCountRows[0].count),
      blankExamples: blankExampleRows.map((row) => ({
        rowId: String(row.row_id),
        keyValues: key.map((_column, index) => normalizeCellValue(row[`key_${index}`])),
      })),
      duplicateExamples,
    };
  }, (effect) => Effect.scoped(effect));

  private readonly createSnapshot = Effect.fnUntraced(function* (
    this: DuckDbComparisonExecutor,
    writer: WorkspaceDatabaseConnection,
    request: CreateComparisonSnapshotRequest,
  ): Effect.fn.Return<ComparisonSummary, DataEngineError, Scope.Scope> {
    const baseline = yield* this.acquireSource(request.baselineId);
    const candidate = yield* this.acquireSource(request.candidateId);
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
      ...request.valueColumns.flatMap((column, index) => [
        `b.${quoteIdentifier(column)} AS ${quoteIdentifier(`baseline_${index}`)}`,
        `c.${quoteIdentifier(column)} AS ${quoteIdentifier(`candidate_${index}`)}`,
        `(b.${quoteIdentifier(csvInternalRowIdField)} IS NOT NULL AND c.${quoteIdentifier(csvInternalRowIdField)} IS NOT NULL AND b.${quoteIdentifier(column)} IS DISTINCT FROM c.${quoteIdentifier(column)}) AS ${quoteIdentifier(`changed_${index}`)}`,
      ]),
    ].join(', ');

    this.snapshotReleases.set(request.artifactId, yield* retainDiagnosticContext(
      observeStage('comparison.release-snapshot', this.retireSnapshot(request.artifactId)),
    ));
    this.artifactRegistry.register({
      tableName,
      owner: { kind: 'comparison', comparisonId: request.comparisonId, operationId: request.artifactId },
      role: 'staging',
    });
    yield* comparisonQuery(writer, () => writer.runCancellable(
      `CREATE TABLE ${table} AS SELECT ${projection}
       FROM (SELECT * FROM ${quoteIdentifier(baseline.tableName)} WHERE ${quoteIdentifier(csvDeletedField)} = false) b
       FULL OUTER JOIN (SELECT * FROM ${quoteIdentifier(candidate.tableName)} WHERE ${quoteIdentifier(csvDeletedField)} = false) c ON ${join}`,
    ));
    const changedSums = request.valueColumns
      .map(
        (_column, index) =>
          `coalesce(sum(CASE WHEN ${quoteIdentifier(`changed_${index}`)} THEN 1 ELSE 0 END), 0)::BIGINT AS ${quoteIdentifier(`changed_count_${index}`)}`,
      )
      .join(', ');
    const summaryRows = yield* comparisonQuery(writer, () => writer.readObjectsCancellable(
      `SELECT coalesce(sum(CASE WHEN classification = 'changed' THEN 1 ELSE 0 END), 0)::BIGINT AS changed,
        coalesce(sum(CASE WHEN classification = 'baseline-only' THEN 1 ELSE 0 END), 0)::BIGINT AS baseline_only,
        coalesce(sum(CASE WHEN classification = 'candidate-only' THEN 1 ELSE 0 END), 0)::BIGINT AS candidate_only,
        coalesce(sum(CASE WHEN classification = 'unchanged' THEN 1 ELSE 0 END), 0)::BIGINT AS unchanged,
        count(*)::BIGINT AS total${changedSums ? `, ${changedSums}` : ''} FROM ${table}`,
    ));
    const row = summaryRows[0];
    return {
      rows: {
        changed: normalizeCount(row.changed),
        baselineOnly: normalizeCount(row.baseline_only),
        candidateOnly: normalizeCount(row.candidate_only),
        unchanged: normalizeCount(row.unchanged),
        total: normalizeCount(row.total),
      },
      changedColumns: request.valueColumns.map((name, index) => ({
        name,
        changedRowCount: normalizeCount(row[`changed_count_${index}`]),
      })),
    };
  }, (effect) => Effect.scoped(effect));

  activateSnapshot(artifactId: ComparisonOperationId): void {
    if (!this.hasSnapshot(artifactId) || this.retirements.has(artifactId)) {
      throw new Error('Comparison staging snapshot is no longer available.');
    }
    this.artifactRegistry.transition(buildComparisonTableName(artifactId), 'active');
  }

  // Owner-connection queries cannot be cancelled. Keep the lease until they settle.
  readonly readWindow = Effect.fnUntraced(function* (
    this: DuckDbComparisonExecutor,
    request: ReadComparisonSnapshotWindowRequest,
  ): Effect.fn.Return<StoredComparisonWindow, DataEngineError, Scope.Scope> {
    if (!isValidRowWindow(request.offset, request.limit)) {
      throw new Error(
        'Comparison window requires a non-negative offset and a limit of at most 1,000.',
      );
    }
    yield* Effect.acquireRelease(
      this.acquireRead(request.artifactId),
      () => this.releaseRead(request.artifactId),
    );
    const connection = yield* databaseEffect(() => this.database.getOwnerConnection());
    const table = quoteIdentifier(buildComparisonTableName(request.artifactId));
    const where = request.differencesOnly ? ` WHERE classification <> 'unchanged'` : '';
    const order = Array.from({ length: request.keyCount }, (_value, index) =>
      `${quoteIdentifier(`key_${index}`)} COLLATE "binary"`,
    ).join(', ');
    const countRows = yield* databaseEffect(() => connection.readObjects(
      `SELECT count(*)::BIGINT AS count FROM ${table}${where}`,
    ));
    const resultRows = yield* databaseEffect(() => connection.readObjects(
      `SELECT * FROM ${table}${where}${order ? ` ORDER BY ${order} ASC` : ''} LIMIT ${request.limit} OFFSET ${request.offset}`,
    ));
    const rows = resultRows.map((row): ComparisonRow => {
      const classification = parseClassification(row.classification);
      const baselineSide =
        row.baseline_row_id == null
          ? null
          : {
              rowId: String(row.baseline_row_id),
              values: request.columnIndexes.map((index) =>
                normalizeCellValue(row[`baseline_${index}`]),
              ),
            };
      const candidateSide =
        row.candidate_row_id == null
          ? null
          : {
              rowId: String(row.candidate_row_id),
              values: request.columnIndexes.map((index) =>
                normalizeCellValue(row[`candidate_${index}`]),
              ),
            };
      return {
        classification: request.swapped ? flipClassification(classification) : classification,
        keyValues: Array.from({ length: request.keyCount }, (_value, index) =>
          String(row[`key_${index}`]),
        ),
        baseline: request.swapped ? candidateSide : baselineSide,
        candidate: request.swapped ? baselineSide : candidateSide,
        changed: request.columnIndexes.map((index) => Boolean(row[`changed_${index}`])),
      };
    });
    return { totalRowCount: normalizeCount(countRows[0].count), rows };
  }, Effect.scoped, Effect.uninterruptible);

  // A shared retirement must finish waiting and dropping even if a caller is interrupted.
  readonly dropSnapshot = Effect.fnUntraced(function* (
    this: DuckDbComparisonExecutor,
    artifactId: ComparisonOperationId,
  ): Effect.fn.Return<void, DataEngineError> {
    const existing = this.retirements.get(artifactId);
    if (existing) return yield* existing;
    if (!this.hasSnapshot(artifactId)) return;
    const release = this.snapshotReleases.get(artifactId);
    if (!release) throw new Error('Comparison snapshot release is missing.');
    const retirement = yield* Effect.cached(release.pipe(
      Effect.ensuring(Effect.sync(() => this.retirements.delete(artifactId))),
    ));
    this.retirements.set(artifactId, retirement);
    yield* retirement;
  }, Effect.uninterruptible);

  // Attempt all independent cleanup before reporting disposal failure.
  readonly dispose = Effect.fnUntraced(function* (
    this: DuckDbComparisonExecutor,
  ): Effect.fn.Return<void, DataEngineError> {
    const failures: Cause.Cause<DataEngineError>[] = [];
    for (const release of [...this.failedSources.values()]) {
      const result = yield* Effect.exit(release);
      if (Exit.isFailure(result)) failures.push(result.cause);
    }
    for (const release of [...this.failedWorkers.values()]) {
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
  ): Effect.fn.Return<void, DataEngineError> {
    const drained = yield* Deferred.make<void>();
    yield* Effect.try({
      try: () => {
        if (!this.hasSnapshot(artifactId) || this.retirements.has(artifactId)) {
          throw new Error('Comparison snapshot is no longer available.');
        }
        const readers = this.readers.get(artifactId);
        if (readers) readers.count += 1;
        else this.readers.set(artifactId, { count: 1, drained });
      },
      catch: (cause) => new DataEngineError(cause),
    });
  });

  private readonly releaseRead = Effect.fnUntraced(function* (
    this: DuckDbComparisonExecutor,
    artifactId: ComparisonOperationId,
  ): Effect.fn.Return<void> {
    const readers = this.readers.get(artifactId);
    if (!readers) throw new Error('Comparison reader lease is missing.');
    readers.count -= 1;
    if (readers.count > 0) return;
    this.readers.delete(artifactId);
    yield* Deferred.succeed(readers.drained, undefined);
  });

  private waitForReaders(artifactId: ComparisonOperationId): Effect.Effect<void> {
    return Effect.suspend(() => {
      const readers = this.readers.get(artifactId);
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
    const connection = yield* databaseEffect(() => this.database.getOwnerConnection());
    yield* databaseEffect(() => connection.run(buildDropTableSql(tableName)));
    this.artifactRegistry.remove(tableName);
    this.snapshotReleases.delete(artifactId);
  });

  private hasSnapshot(artifactId: ComparisonOperationId): boolean {
    return this.artifactRegistry.get(buildComparisonTableName(artifactId)) !== null;
  }
}

function parseClassification(value: EngineCellValue | undefined): ComparisonRow['classification'] {
  if (
    value === 'changed' ||
    value === 'baseline-only' ||
    value === 'candidate-only' ||
    value === 'unchanged'
  ) {
    return value;
  }
  throw new Error('Comparison snapshot contains an invalid classification.');
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
