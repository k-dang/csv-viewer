import type { DuckDBConnection } from '@duckdb/node-api';
import type {
  ComparisonRow,
  ComparisonOperationId,
  ComparisonSummary,
  CsvColumn,
  SourceKeyDiagnostics,
  WorkingCsvId,
} from '../../shared/ipc';
import { csvInternalRowIdField } from '../../shared/ipc';
import type {
  ComparisonExecutor,
  CreateComparisonSnapshotRequest,
  ReadComparisonSnapshotWindowRequest,
  StoredComparisonWindow,
} from '../comparison-executor';
import { assertKnownColumn, quoteIdentifier } from '../csv-query';
import { normalizeCellValue, normalizeCount } from '../csv-result-normalization';
import { csvDeletedField, csvSourceOrderField } from '../csv-storage-schema';
import { WorkspaceArtifactRegistry } from '../workspace-artifact-registry';

export type ComparisonSource = {
  tableName: string;
  columns: CsvColumn[];
  release(): Promise<void>;
};

export type DuckDbComparisonAccess = {
  acquireSource(workingCsvId: WorkingCsvId): Promise<ComparisonSource>;
  getOwnerConnection(): Promise<DuckDBConnection>;
  connectWorker(): Promise<DuckDBConnection>;
};

type ComparisonWorker = {
  connection: Promise<DuckDBConnection>;
  cancelled: boolean;
};

export class DuckDbComparisonExecutor implements ComparisonExecutor {
  private readonly artifacts = new Set<ComparisonOperationId>();
  private readonly workers = new Map<ComparisonOperationId, ComparisonWorker>();
  private readonly readCounts = new Map<ComparisonOperationId, number>();
  private readonly readWaiters = new Map<ComparisonOperationId, Array<() => void>>();
  private readonly retirements = new Map<ComparisonOperationId, Promise<void>>();

  constructor(
    private readonly database: DuckDbComparisonAccess,
    private readonly artifactRegistry = new WorkspaceArtifactRegistry(),
  ) {}

  async validateKey(
    operationId: ComparisonOperationId,
    workingCsvId: WorkingCsvId,
    key: string[],
  ): Promise<SourceKeyDiagnostics> {
    if (key.length === 0) throw new Error('Comparison key requires at least one column.');
    const source = await this.database.acquireSource(workingCsvId);
    try {
      const writer = await this.getWriter(operationId);
      const known = new Set(source.columns.map((column) => column.name));
      key.forEach((column) => assertKnownColumn(column, known));
      const table = quoteIdentifier(source.tableName);
    const active = `${quoteIdentifier(csvDeletedField)} = false`;
    const blank = key
      .map((column) => `(${quoteIdentifier(column)} IS NULL OR ${quoteIdentifier(column)} = '')`)
      .join(' OR ');
    const present = key
      .map(
        (column) => `(${quoteIdentifier(column)} IS NOT NULL AND ${quoteIdentifier(column)} <> '')`,
      )
      .join(' AND ');
    const keyProjection = key
      .map((column, index) => `${quoteIdentifier(column)} AS ${quoteIdentifier(`key_${index}`)}`)
      .join(', ');
    const keyGroup = key.map(quoteIdentifier).join(', ');
    const keyOrder = key
      .map((column) => `${quoteIdentifier(column)} COLLATE "binary" ASC`)
      .join(', ');
    const blankCountResult = await writer.runAndReadAll(
      `SELECT count(*)::BIGINT AS count FROM ${table} WHERE ${active} AND (${blank})`,
    );
    const blankExamplesResult = await writer.runAndReadAll(
      `SELECT ${quoteIdentifier(csvInternalRowIdField)} AS row_id, ${keyProjection} FROM ${table}
       WHERE ${active} AND (${blank}) ORDER BY ${quoteIdentifier(csvSourceOrderField)} ASC LIMIT 5`,
    );
    const duplicateCountResult = await writer.runAndReadAll(
      `SELECT count(*)::BIGINT AS count FROM (
        SELECT 1 FROM ${table} WHERE ${active} AND (${present}) GROUP BY ${keyGroup} HAVING count(*) > 1
      ) duplicate_groups`,
    );
    const duplicateGroupsResult = await writer.runAndReadAll(
      `SELECT ${keyProjection}, count(*)::BIGINT AS row_count FROM ${table} WHERE ${active} AND (${present})
       GROUP BY ${keyGroup} HAVING count(*) > 1 ORDER BY ${keyOrder} LIMIT 5`,
    );
    const duplicateExamples: SourceKeyDiagnostics['duplicateExamples'] = [];
    for (const group of duplicateGroupsResult.getRowObjectsJS()) {
      const keyValues = key.map((_column, index) => String(group[`key_${index}`]));
      const conditions = key.map((column) => `${quoteIdentifier(column)} = ?`).join(' AND ');
      const rowIdsResult = await writer.runAndReadAll(
        `SELECT ${quoteIdentifier(csvInternalRowIdField)} AS row_id FROM ${table}
         WHERE ${active} AND ${conditions} ORDER BY ${quoteIdentifier(csvSourceOrderField)} ASC LIMIT 5`,
        keyValues,
      );
      duplicateExamples.push({
        keyValues,
        rowCount: normalizeCount(group.row_count),
        rowIds: rowIdsResult.getRowObjectsJS().map((row) => String(row.row_id)),
      });
    }
      return {
        blankRowCount: normalizeCount(blankCountResult.getRowObjectsJS()[0].count),
        duplicateGroupCount: normalizeCount(duplicateCountResult.getRowObjectsJS()[0].count),
        blankExamples: blankExamplesResult.getRowObjectsJS().map((row) => ({
          rowId: String(row.row_id),
          keyValues: key.map((_column, index) => normalizeCellValue(row[`key_${index}`])),
        })),
        duplicateExamples,
      };
    } finally {
      await source.release();
    }
  }

  async createSnapshot(request: CreateComparisonSnapshotRequest): Promise<ComparisonSummary> {
    const sources = await this.acquireSources([request.baselineId, request.candidateId]);
    const [baseline, candidate] = sources;
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
    try {
      const writer = await this.getWriter(request.artifactId);
      try {
        await this.dropSnapshot(request.artifactId);
        this.artifactRegistry.register({
          tableName,
          owner: { kind: 'comparison', comparisonId: request.comparisonId },
          role: 'staging',
          operationId: request.artifactId,
        });
        this.artifacts.add(request.artifactId);
        await writer.run(
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
        const summaryResult = await writer.runAndReadAll(
          `SELECT coalesce(sum(CASE WHEN classification = 'changed' THEN 1 ELSE 0 END), 0)::BIGINT AS changed,
            coalesce(sum(CASE WHEN classification = 'baseline-only' THEN 1 ELSE 0 END), 0)::BIGINT AS baseline_only,
            coalesce(sum(CASE WHEN classification = 'candidate-only' THEN 1 ELSE 0 END), 0)::BIGINT AS candidate_only,
            coalesce(sum(CASE WHEN classification = 'unchanged' THEN 1 ELSE 0 END), 0)::BIGINT AS unchanged,
            count(*)::BIGINT AS total${changedSums ? `, ${changedSums}` : ''} FROM ${table}`,
        );
        const row = summaryResult.getRowObjectsJS()[0];
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
      } catch (error) {
        await this.cleanupFailedSnapshot(request.artifactId).catch((cleanupError) => {
          console.error('Unable to clean a failed Comparison staging artifact.', cleanupError);
        });
        throw error;
      }
    } finally {
      await Promise.all(sources.map((source) => source.release()));
    }
  }

  activateSnapshot(artifactId: ComparisonOperationId): void {
    if (!this.artifacts.has(artifactId) || this.retirements.has(artifactId)) {
      throw new Error('Comparison staging snapshot is no longer available.');
    }
    this.artifactRegistry.transition(buildComparisonTableName(artifactId), 'active');
  }

  cancel(operationId: ComparisonOperationId): void {
    const worker = this.workers.get(operationId);
    if (!worker) return;
    worker.cancelled = true;
    void worker.connection.then(
      (connection) => connection.interrupt(),
      () => undefined,
    );
  }

  async release(operationId: ComparisonOperationId): Promise<void> {
    const worker = this.workers.get(operationId);
    if (!worker) return;
    try {
      const connection = await worker.connection;
      connection.closeSync();
    } finally {
      if (this.workers.get(operationId) === worker) this.workers.delete(operationId);
    }
  }

  async readWindow(request: ReadComparisonSnapshotWindowRequest): Promise<StoredComparisonWindow> {
    if (
      !Number.isSafeInteger(request.offset) ||
      request.offset < 0 ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 0 ||
      request.limit > 1000
    ) {
      throw new Error(
        'Comparison window requires a non-negative offset and a limit of at most 1,000.',
      );
    }
    this.acquireRead(request.artifactId);
    try {
      const connection = await this.database.getOwnerConnection();
      const table = quoteIdentifier(buildComparisonTableName(request.artifactId));
      const where = request.differencesOnly ? ` WHERE classification <> 'unchanged'` : '';
      const order = Array.from({ length: request.keyCount }, (_value, index) =>
        `${quoteIdentifier(`key_${index}`)} COLLATE "binary"`,
      ).join(', ');
      const countResult = await connection.runAndReadAll(
        `SELECT count(*)::BIGINT AS count FROM ${table}${where}`,
      );
      const rowsResult = await connection.runAndReadAll(
        `SELECT * FROM ${table}${where}${order ? ` ORDER BY ${order} ASC` : ''} LIMIT ${request.limit} OFFSET ${request.offset}`,
      );
      const rows = rowsResult.getRowObjectsJS().map((row): ComparisonRow => {
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
      return { totalRowCount: normalizeCount(countResult.getRowObjectsJS()[0].count), rows };
    } finally {
      this.releaseRead(request.artifactId);
    }
  }

  async dropSnapshot(artifactId: ComparisonOperationId): Promise<void> {
    const existing = this.retirements.get(artifactId);
    if (existing) return existing;
    if (!this.artifacts.has(artifactId)) return;
    const retirement = this.retireSnapshot(artifactId);
    this.retirements.set(artifactId, retirement);
    return retirement;
  }

  async dispose(): Promise<void> {
    const failures: Error[] = [];
    for (const operationId of [...this.workers.keys()]) this.cancel(operationId);
    for (const operationId of [...this.workers.keys()]) {
      try {
        await this.release(operationId);
      } catch (error) {
        failures.push(normalizeError(error));
      }
    }
    for (const artifactId of [...this.artifacts]) {
      try {
        await this.dropSnapshot(artifactId);
      } catch (error) {
        failures.push(normalizeError(error));
      }
    }
    try {
      this.artifactRegistry.assertNoArtifactsOwnedBy('comparison');
    } catch (error) {
      failures.push(normalizeError(error));
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Unable to dispose all Comparison executor resources.');
    }
  }

  private async getWriter(operationId: ComparisonOperationId): Promise<DuckDBConnection> {
    const existing = this.workers.get(operationId);
    if (existing) {
      const connection = await existing.connection;
      if (this.workers.get(operationId) !== existing || existing.cancelled) {
        throw new Error('Comparison operation was cancelled.');
      }
      return connection;
    }
    const worker: ComparisonWorker = {
      connection: this.database.connectWorker(),
      cancelled: false,
    };
    this.workers.set(operationId, worker);
    let writer: DuckDBConnection;
    try {
      writer = await worker.connection;
    } catch (error) {
      if (this.workers.get(operationId) === worker) this.workers.delete(operationId);
      throw error;
    }
    if (this.workers.get(operationId) !== worker || worker.cancelled) {
      throw new Error('Comparison operation was cancelled.');
    }
    return writer;
  }

  private async acquireSources(workingCsvIds: WorkingCsvId[]): Promise<ComparisonSource[]> {
    const sources: ComparisonSource[] = [];
    try {
      for (const workingCsvId of workingCsvIds) {
        sources.push(await this.database.acquireSource(workingCsvId));
      }
      return sources;
    } catch (error) {
      await Promise.all(sources.map((source) => source.release()));
      throw error;
    }
  }

  private acquireRead(artifactId: ComparisonOperationId): void {
    if (!this.artifacts.has(artifactId) || this.retirements.has(artifactId)) {
      throw new Error('Comparison snapshot is no longer available.');
    }
    this.readCounts.set(artifactId, (this.readCounts.get(artifactId) ?? 0) + 1);
  }

  private releaseRead(artifactId: ComparisonOperationId): void {
    const next = (this.readCounts.get(artifactId) ?? 1) - 1;
    if (next > 0) {
      this.readCounts.set(artifactId, next);
      return;
    }
    this.readCounts.delete(artifactId);
    const waiters = this.readWaiters.get(artifactId) ?? [];
    this.readWaiters.delete(artifactId);
    waiters.forEach((resolve) => resolve());
  }

  private async waitForReaders(artifactId: ComparisonOperationId): Promise<void> {
    if ((this.readCounts.get(artifactId) ?? 0) === 0) return;
    await new Promise<void>((resolve) => {
      const waiters = this.readWaiters.get(artifactId) ?? [];
      waiters.push(resolve);
      this.readWaiters.set(artifactId, waiters);
    });
  }

  private async retireSnapshot(artifactId: ComparisonOperationId): Promise<void> {
    try {
      const tableName = buildComparisonTableName(artifactId);
      this.artifactRegistry.transition(tableName, 'retired');
      await this.waitForReaders(artifactId);
      const connection = await this.database.getOwnerConnection();
      await connection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`);
      this.artifacts.delete(artifactId);
      this.artifactRegistry.remove(tableName);
    } finally {
      this.retirements.delete(artifactId);
    }
  }

  private async cleanupFailedSnapshot(artifactId: ComparisonOperationId): Promise<void> {
    if (!this.artifacts.has(artifactId)) return;
    const tableName = buildComparisonTableName(artifactId);
    const connection = await this.database.getOwnerConnection();
    await connection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`);
    this.artifacts.delete(artifactId);
    this.artifactRegistry.remove(tableName);
  }
}

function parseClassification(value: unknown): ComparisonRow['classification'] {
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

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
