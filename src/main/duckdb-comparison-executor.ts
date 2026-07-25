import type { DuckDBConnection } from '@duckdb/node-api';
import type {
  ComparisonRow,
  ComparisonSummary,
  CsvColumn,
  SourceKeyDiagnostics,
} from '../shared/ipc';
import { csvInternalRowIdField } from '../shared/ipc';
import type {
  ComparisonExecutor,
  CreateComparisonSnapshotRequest,
  ReadComparisonSnapshotWindowRequest,
  StoredComparisonWindow,
} from './comparison-executor';
import {
  assertKnownColumn,
  normalizeCellValue,
  normalizeCount,
  quoteIdentifier,
} from './csv-query';
import { csvDeletedField, csvSourceOrderField } from './csv-storage-schema';

export type ComparisonSource = {
  tableName: string;
  columns: CsvColumn[];
};

export type DuckDbComparisonAccess = {
  getSource(sessionId: string): ComparisonSource;
  getOwnerConnection(): Promise<DuckDBConnection>;
  connectWorker(): Promise<DuckDBConnection>;
};

export class DuckDbComparisonExecutor implements ComparisonExecutor {
  private readonly artifacts = new Set<string>();
  private readonly writers = new Map<string, Promise<DuckDBConnection>>();
  private readonly readCounts = new Map<string, number>();
  private readonly readWaiters = new Map<string, Array<() => void>>();
  private readonly retirements = new Map<string, Promise<void>>();

  constructor(private readonly database: DuckDbComparisonAccess) {}

  async validateKey(
    operationId: string,
    sessionId: string,
    key: string[],
  ): Promise<SourceKeyDiagnostics> {
    if (key.length === 0) throw new Error('Comparison key requires at least one column.');
    const source = this.database.getSource(sessionId);
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
    const keyOrder = key.map((column) => `${quoteIdentifier(column)} ASC`).join(', ');
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
  }

  async createSnapshot(request: CreateComparisonSnapshotRequest): Promise<ComparisonSummary> {
    const baseline = this.database.getSource(request.baselineId);
    const candidate = this.database.getSource(request.candidateId);
    const table = quoteIdentifier(buildComparisonTableName(request.artifactId));
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
    const writer = await this.getWriter(request.artifactId);
    try {
      await this.dropSnapshot(request.artifactId);
      await writer.run(
        `CREATE TABLE ${table} AS SELECT ${projection}
         FROM (SELECT * FROM ${quoteIdentifier(baseline.tableName)} WHERE ${quoteIdentifier(csvDeletedField)} = false) b
         FULL OUTER JOIN (SELECT * FROM ${quoteIdentifier(candidate.tableName)} WHERE ${quoteIdentifier(csvDeletedField)} = false) c ON ${join}`,
      );
      this.artifacts.add(request.artifactId);
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
    } finally {
      if (this.writers.has(request.artifactId)) {
        this.writers.delete(request.artifactId);
        writer.closeSync();
      }
    }
  }

  cancel(operationId: string): void {
    const writer = this.writers.get(operationId);
    if (!writer) return;
    this.writers.delete(operationId);
    void writer.then(
      (connection) => connection.closeSync(),
      () => undefined,
    );
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
        quoteIdentifier(`key_${index}`),
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

  async dropSnapshot(artifactId: string): Promise<void> {
    const existing = this.retirements.get(artifactId);
    if (existing) return existing;
    if (!this.artifacts.has(artifactId)) return;
    const retirement = this.retireSnapshot(artifactId);
    this.retirements.set(artifactId, retirement);
    return retirement;
  }

  async dispose(): Promise<void> {
    for (const operationId of [...this.writers.keys()]) this.cancel(operationId);
    for (const artifactId of [...this.artifacts]) await this.dropSnapshot(artifactId);
  }

  private async getWriter(operationId: string): Promise<DuckDBConnection> {
    const existing = this.writers.get(operationId);
    if (existing) return existing;
    const pending = this.database.connectWorker();
    this.writers.set(operationId, pending);
    try {
      const writer = await pending;
      if (this.writers.get(operationId) !== pending) {
        throw new Error('Comparison operation was cancelled.');
      }
      return writer;
    } catch (error) {
      if (this.writers.get(operationId) === pending) this.writers.delete(operationId);
      throw error;
    }
  }

  private acquireRead(artifactId: string): void {
    if (!this.artifacts.has(artifactId) || this.retirements.has(artifactId)) {
      throw new Error('Comparison snapshot is no longer available.');
    }
    this.readCounts.set(artifactId, (this.readCounts.get(artifactId) ?? 0) + 1);
  }

  private releaseRead(artifactId: string): void {
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

  private async waitForReaders(artifactId: string): Promise<void> {
    if ((this.readCounts.get(artifactId) ?? 0) === 0) return;
    await new Promise<void>((resolve) => {
      const waiters = this.readWaiters.get(artifactId) ?? [];
      waiters.push(resolve);
      this.readWaiters.set(artifactId, waiters);
    });
  }

  private async retireSnapshot(artifactId: string): Promise<void> {
    try {
      await this.waitForReaders(artifactId);
      const connection = await this.database.getOwnerConnection();
      await connection.run(
        `DROP TABLE IF EXISTS ${quoteIdentifier(buildComparisonTableName(artifactId))}`,
      );
      this.artifacts.delete(artifactId);
    } finally {
      this.retirements.delete(artifactId);
    }
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

function buildComparisonTableName(artifactId: string): string {
  return `csv_comparison_${artifactId.replaceAll('-', '_')}`;
}

function flipClassification(
  classification: ComparisonRow['classification'],
): ComparisonRow['classification'] {
  if (classification === 'baseline-only') return 'candidate-only';
  if (classification === 'candidate-only') return 'baseline-only';
  return classification;
}
