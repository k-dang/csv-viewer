import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';

const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
const numberValue = (value) => Number(value ?? 0);

async function rows(connection, sql, values = undefined) {
  const result = values
    ? await connection.runAndReadAll(sql, values)
    : await connection.runAndReadAll(sql);
  return result.getRowObjectsJS();
}

async function sourceDiagnostics(connection, tableName, key) {
  const table = quoteIdentifier(tableName);
  const active = '__deleted = false';
  const blank = key.map((column) => `(${quoteIdentifier(column)} IS NULL OR ${quoteIdentifier(column)} = '')`).join(' OR ');
  const present = key.map((column) => `(${quoteIdentifier(column)} IS NOT NULL AND ${quoteIdentifier(column)} <> '')`).join(' AND ');
  const projection = key.map((column, index) => `${quoteIdentifier(column)} AS key_${index}`).join(', ');
  const group = key.map(quoteIdentifier).join(', ');
  const order = key.map((column) => `${quoteIdentifier(column)} COLLATE "binary"`).join(', ');
  const [blankCount] = await rows(connection, `SELECT count(*)::BIGINT AS count FROM ${table} WHERE ${active} AND (${blank})`);
  const blankExamples = await rows(connection, `SELECT __row_id AS row_id, ${projection} FROM ${table} WHERE ${active} AND (${blank}) ORDER BY __source_order LIMIT 5`);
  const [duplicateCount] = await rows(connection, `SELECT count(*)::BIGINT AS count FROM (SELECT 1 FROM ${table} WHERE ${active} AND (${present}) GROUP BY ${group} HAVING count(*) > 1)`);
  const duplicateGroups = await rows(connection, `SELECT ${projection}, count(*)::BIGINT AS row_count FROM ${table} WHERE ${active} AND (${present}) GROUP BY ${group} HAVING count(*) > 1 ORDER BY ${order} LIMIT 5`);
  const duplicateExamples = [];
  for (const duplicate of duplicateGroups) {
    const keyValues = key.map((_column, index) => String(duplicate[`key_${index}`]));
    const predicates = key.map((column) => `${quoteIdentifier(column)} = ?`).join(' AND ');
    const ids = await rows(connection, `SELECT __row_id AS row_id FROM ${table} WHERE ${active} AND ${predicates} ORDER BY __source_order LIMIT 5`, keyValues);
    duplicateExamples.push({
      keyValues,
      rowCount: numberValue(duplicate.row_count),
      rowIds: ids.map((row) => String(row.row_id)),
    });
  }
  return {
    blankRowCount: numberValue(blankCount.count),
    duplicateGroupCount: numberValue(duplicateCount.count),
    blankExamples: blankExamples.map((row) => ({
      rowId: String(row.row_id),
      keyValues: key.map((_column, index) => row[`key_${index}`] == null ? null : String(row[`key_${index}`])),
    })),
    duplicateExamples,
  };
}

async function materializeSnapshot(connection, { tableName, baseline, candidate, key, valueColumns }) {
  const table = quoteIdentifier(tableName);
  const join = key.map((column) => `b.${quoteIdentifier(column)} = c.${quoteIdentifier(column)}`).join(' AND ');
  const changedExpressions = valueColumns.map((column) => `b.${quoteIdentifier(column)} IS DISTINCT FROM c.${quoteIdentifier(column)}`);
  const anyChanged = changedExpressions.join(' OR ') || 'false';
  const projection = [
    `CASE WHEN b.__row_id IS NULL THEN 'candidate-only' WHEN c.__row_id IS NULL THEN 'baseline-only' WHEN ${anyChanged} THEN 'changed' ELSE 'unchanged' END AS classification`,
    ...key.map((column, index) => `coalesce(b.${quoteIdentifier(column)}, c.${quoteIdentifier(column)}) AS key_${index}`),
    'b.__row_id AS baseline_row_id',
    'c.__row_id AS candidate_row_id',
    ...valueColumns.flatMap((column, index) => [
      `b.${quoteIdentifier(column)} AS baseline_${index}`,
      `c.${quoteIdentifier(column)} AS candidate_${index}`,
      `(b.__row_id IS NOT NULL AND c.__row_id IS NOT NULL AND b.${quoteIdentifier(column)} IS DISTINCT FROM c.${quoteIdentifier(column)}) AS changed_${index}`,
    ]),
  ].join(', ');
  await connection.run(`CREATE TABLE ${table} AS SELECT ${projection} FROM (SELECT * FROM ${quoteIdentifier(baseline)} WHERE __deleted = false) b FULL OUTER JOIN (SELECT * FROM ${quoteIdentifier(candidate)} WHERE __deleted = false) c ON ${join}`);
  return snapshotSummary(connection, tableName, valueColumns);
}

async function snapshotSummary(connection, tableName, valueColumns) {
  const changedCounts = valueColumns.map((_column, index) => `coalesce(sum(CASE WHEN changed_${index} THEN 1 ELSE 0 END), 0)::BIGINT AS changed_${index}`).join(', ');
  const [summary] = await rows(connection, `SELECT
    coalesce(sum(classification = 'changed'), 0)::BIGINT AS changed,
    coalesce(sum(classification = 'baseline-only'), 0)::BIGINT AS baseline_only,
    coalesce(sum(classification = 'candidate-only'), 0)::BIGINT AS candidate_only,
    coalesce(sum(classification = 'unchanged'), 0)::BIGINT AS unchanged,
    count(*)::BIGINT AS total${changedCounts ? `, ${changedCounts}` : ''}
    FROM ${quoteIdentifier(tableName)}`);
  return {
    rows: {
      changed: numberValue(summary.changed),
      baselineOnly: numberValue(summary.baseline_only),
      candidateOnly: numberValue(summary.candidate_only),
      unchanged: numberValue(summary.unchanged),
      total: numberValue(summary.total),
    },
    changedColumns: valueColumns.map((name, index) => ({
      name,
      changedRowCount: numberValue(summary[`changed_${index}`]),
    })),
  };
}

async function snapshotWindow(connection, tableName, keyCount, offset, limit, differencesOnly = false) {
  assert(Number.isSafeInteger(offset) && offset >= 0);
  assert(Number.isSafeInteger(limit) && limit >= 0 && limit <= 1_000);
  const predicate = differencesOnly ? ` WHERE classification <> 'unchanged'` : '';
  const order = Array.from({ length: keyCount }, (_value, index) => `key_${index} COLLATE "binary"`).join(', ');
  return rows(connection, `SELECT * FROM ${quoteIdentifier(tableName)}${predicate} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`);
}

const database = await DuckDBInstance.create(':memory:');
const owner = await database.connect();
let worker = null;

try {
  await owner.run(`CREATE TABLE baseline (
    __row_id VARCHAR, __source_order BIGINT, __deleted BOOLEAN,
    key_a VARCHAR, key_b VARCHAR, value VARCHAR, nullable VARCHAR
  )`);
  await owner.run(`CREATE TABLE candidate (
    __row_id VARCHAR, __source_order BIGINT, __deleted BOOLEAN,
    nullable VARCHAR, value VARCHAR, key_b VARCHAR, key_a VARCHAR
  )`);
  await owner.run(`INSERT INTO baseline VALUES
    ('b1', 1, false, 'A', '1', 'old', NULL),
    ('b2', 2, false, 'B', '2', 'same', ''),
    ('b3', 3, false, 'C', '3', 'baseline', 'base'),
    ('b4', 4, false, 'E', '5', 'exact', NULL),
    ('b5', 5, false, 'F', '6', 'Alpha', ' x'),
    ('b6', 6, false, 'G', '7', 'baseline-only', NULL),
    ('b7', 7, true,  'X', '9', 'deleted', NULL)`);
  await owner.run(`INSERT INTO candidate VALUES
    ('c1', 1, false, NULL, 'new', '1', 'A'),
    ('c2', 2, false, '', 'same', '2', 'B'),
    ('c3', 3, false, 'candidate', 'candidate-only', '4', 'D'),
    ('c4', 4, false, '', 'exact', '5', 'E'),
    ('c5', 5, false, 'x ', 'alpha', '6', 'F'),
    ('c6', 6, false, NULL, 'candidate-only', '8', 'H'),
    ('c7', 7, true,  NULL, 'deleted', '9', 'X')`);

  await owner.run(`CREATE TABLE invalid_keys AS SELECT * FROM baseline WHERE false`);
  await owner.run(`INSERT INTO invalid_keys VALUES
    ('i1', 1, false, NULL, '1', 'blank-null', NULL),
    ('i2', 2, false, '', '2', 'blank-empty', NULL),
    ('i3', 3, false, 'Q', '1', 'duplicate', NULL),
    ('i4', 4, false, 'Q', '1', 'duplicate', NULL),
    ('i5', 5, false, 'R', '2', 'duplicate', NULL),
    ('i6', 6, false, 'R', '2', 'duplicate', NULL)`);
  assert.deepEqual(await sourceDiagnostics(owner, 'invalid_keys', ['key_a', 'key_b']), {
    blankRowCount: 2,
    duplicateGroupCount: 2,
    blankExamples: [
      { rowId: 'i1', keyValues: [null, '1'] },
      { rowId: 'i2', keyValues: ['', '2'] },
    ],
    duplicateExamples: [
      { keyValues: ['Q', '1'], rowCount: 2, rowIds: ['i3', 'i4'] },
      { keyValues: ['R', '2'], rowCount: 2, rowIds: ['i5', 'i6'] },
    ],
  });

  const valueColumns = ['value', 'nullable'];
  const firstSummary = await materializeSnapshot(owner, {
    tableName: 'prototype_snapshot_first', baseline: 'baseline', candidate: 'candidate',
    key: ['key_a', 'key_b'], valueColumns,
  });
  assert.deepEqual(firstSummary, {
    rows: { changed: 3, baselineOnly: 2, candidateOnly: 2, unchanged: 1, total: 8 },
    changedColumns: [
      { name: 'value', changedRowCount: 2 },
      { name: 'nullable', changedRowCount: 2 },
    ],
  });
  const firstWindow = await snapshotWindow(owner, 'prototype_snapshot_first', 2, 0, 1_000);
  assert.deepEqual(firstWindow.map((row) => [row.key_0, row.key_1, row.classification]), [
    ['A', '1', 'changed'], ['B', '2', 'unchanged'], ['C', '3', 'baseline-only'],
    ['D', '4', 'candidate-only'], ['E', '5', 'changed'], ['F', '6', 'changed'],
    ['G', '7', 'baseline-only'], ['H', '8', 'candidate-only'],
  ]);

  await owner.run(`CREATE VIEW prototype_live_view AS SELECT b.value AS baseline_value FROM baseline b JOIN candidate c USING (key_a, key_b) WHERE b.key_a = 'A'`);
  assert.equal((await rows(owner, 'SELECT baseline_value FROM prototype_live_view'))[0].baseline_value, 'old');
  await owner.run(`UPDATE baseline SET value = 'new' WHERE key_a = 'A'; UPDATE baseline SET __deleted = true WHERE key_a = 'G'; UPDATE candidate SET value = 'edited' WHERE key_a = 'B'; UPDATE candidate SET __deleted = true WHERE key_a = 'D'`);
  assert.equal((await rows(owner, 'SELECT baseline_value FROM prototype_live_view'))[0].baseline_value, 'new');
  assert.equal((await rows(owner, `SELECT baseline_0 FROM prototype_snapshot_first WHERE key_0 = 'A'`))[0].baseline_0, 'old');
  assert.deepEqual(await snapshotSummary(owner, 'prototype_snapshot_first', valueColumns), firstSummary);

  const replacementSummary = await materializeSnapshot(owner, {
    tableName: 'prototype_snapshot_replacement', baseline: 'baseline', candidate: 'candidate',
    key: ['key_a', 'key_b'], valueColumns,
  });
  assert.deepEqual(replacementSummary.rows, {
    changed: 3, baselineOnly: 1, candidateOnly: 1, unchanged: 1, total: 6,
  });

  await owner.run(`CREATE TABLE baseline_big AS SELECT
    'b' || i::VARCHAR AS __row_id, i AS __source_order, false AS __deleted,
    lpad(i::VARCHAR, 6, '0') AS id, ('value-' || i::VARCHAR) AS payload
    FROM range(100000) source(i)`);
  await owner.run(`CREATE TABLE candidate_big AS SELECT
    'c' || i::VARCHAR AS __row_id, i AS __source_order, false AS __deleted,
    lpad(i::VARCHAR, 6, '0') AS id,
    CASE WHEN i % 10 = 0 THEN 'changed-' || i::VARCHAR ELSE 'value-' || i::VARCHAR END AS payload
    FROM range(100000) source(i)`);
  const largeSummary = await materializeSnapshot(owner, {
    tableName: 'prototype_snapshot_large', baseline: 'baseline_big', candidate: 'candidate_big',
    key: ['id'], valueColumns: ['payload'],
  });
  assert.deepEqual(largeSummary.rows, {
    changed: 10_000, baselineOnly: 0, candidateOnly: 0, unchanged: 90_000, total: 100_000,
  });
  const boundedWindow = await snapshotWindow(owner, 'prototype_snapshot_large', 1, 12_300, 200);
  assert.equal(boundedWindow.length, 200);
  assert.equal(boundedWindow[0].key_0, '012300');

  worker = await database.connect();
  const expensiveQuery = worker.runAndReadAll(`SELECT sum(sin(a.i::DOUBLE + b.j::DOUBLE)) FROM range(100000000) a(i), range(1000) b(j)`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  worker.interrupt();
  await assert.rejects(expensiveQuery);
  assert.equal(numberValue((await rows(owner, 'SELECT 42 AS answer'))[0].answer), 42);

  await owner.run('DROP VIEW prototype_live_view');
  await owner.run('DROP TABLE prototype_snapshot_first');
  await owner.run('DROP TABLE prototype_snapshot_replacement');
  await owner.run('DROP TABLE prototype_snapshot_large');
  const [artifacts] = await rows(owner, `SELECT count(*)::BIGINT AS count FROM information_schema.tables WHERE table_name LIKE 'prototype_snapshot_%'`);
  assert.equal(numberValue(artifacts.count), 0);

  console.log('Comparison execution prototype passed: diagnostics, exact aligned snapshots, immutable replacement, 100k bounded reads, interruption, owner survival, and cleanup.');
} finally {
  worker?.closeSync();
  owner.closeSync();
  database.closeSync();
}
