import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComparisonRow, ComparisonView, ComparisonWindow, WorkingCsvView } from '../shared/csv-viewer-contract';
import { workspaceContractFactories, type WorkspaceContractFixture } from '../test-helpers/workspace-contract';

async function openComparison(
  value: WorkspaceContractFixture,
  baseline: WorkingCsvView,
  candidate: WorkingCsvView,
): Promise<ComparisonView> {
  const outcome = await value.viewer.call({
    operation: 'comparison.open',
    baselineId: baseline.workingCsvId,
    candidateId: candidate.workingCsvId,
  });
  if (outcome.status === 'rejected') throw new Error(outcome.fault.message);
  return outcome.comparison;
}

/** Runs a Comparison operation to its terminal outcome through Comparison events. */
async function runComparison(
  value: WorkspaceContractFixture,
  comparisonId: string,
  key?: string[],
): Promise<{ status: string; comparison: ComparisonView }> {
  const started = await value.viewer.call(
    key
      ? { operation: 'comparison.begin', kind: 'apply-key', comparisonId, key }
      : { operation: 'comparison.begin', kind: 'refresh', comparisonId },
  );
  if (started.status !== 'accepted') throw new Error(`Comparison was ${started.status}.`);
  const outcome = await value.awaitComparisonOutcome(started.operationId);
  const comparison = value.latestComparison(comparisonId);
  if (!comparison) throw new Error('Comparison disappeared.');
  return { status: outcome.status, comparison };
}

async function applyKey(value: WorkspaceContractFixture, comparisonId: string, key: string[]): Promise<ComparisonView> {
  const completed = await runComparison(value, comparisonId, key);
  if (completed.status !== 'applied') throw new Error(`Comparison completed as ${completed.status}.`);
  return completed.comparison;
}

async function refresh(value: WorkspaceContractFixture, comparisonId: string): Promise<ComparisonView> {
  const completed = await runComparison(value, comparisonId);
  if (completed.status !== 'applied') throw new Error(`Refresh completed as ${completed.status}.`);
  return completed.comparison;
}

async function comparisonState(value: WorkspaceContractFixture, comparisonId: string): Promise<ComparisonView> {
  const comparison = value.latestComparison(comparisonId);
  if (!comparison) throw new Error('Comparison disappeared.');
  return comparison;
}

async function readWindow(
  value: WorkspaceContractFixture,
  comparison: ComparisonView,
  options: {
    offset?: number;
    limit?: number;
    rows?: 'differences' | 'all';
    columns?: 'changed-first' | 'csv-order';
  } = {},
): Promise<ComparisonWindow> {
  if (!comparison.applied) throw new Error('Comparison has no applied result.');
  const outcome = await value.viewer.call({
    operation: 'comparison.get-window',
    comparisonId: comparison.comparisonId,
    resultToken: comparison.applied.resultToken,
    offset: options.offset ?? 0,
    limit: options.limit ?? 100,
    rows: options.rows ?? 'all',
    columns: options.columns ?? 'csv-order',
  });
  if (outcome.status !== 'ready') throw new Error(`Window completed as ${outcome.status}.`);
  return outcome.window;
}

function observableRow(row: ComparisonRow) {
  return {
    classification: row.classification,
    keyValues: row.keyValues,
    baseline: row.baseline?.values ?? null,
    candidate: row.candidate?.values ?? null,
    changed: row.changed,
  };
}

describe.each(workspaceContractFactories)('$name CsvWorkspace Comparison contract', ({ create }) => {
  let value!: WorkspaceContractFixture;
  let fixtureCreated = false;

  beforeEach(async () => {
    fixtureCreated = false;
    value = await create();
    fixtureCreated = true;
  });

  afterEach(async () => {
    if (fixtureCreated) await value.dispose();
  });

  it.each([
    {
      name: 'zero rows',
      baseline: ['id,value', ''].join('\n'),
      candidate: ['id,value', ''].join('\n'),
      expected: { changed: 0, baselineOnly: 0, candidateOnly: 0, unchanged: 0, total: 0 },
    },
    {
      name: 'no differences',
      baseline: ['id,value', '1,same', '2,equal', ''].join('\n'),
      candidate: ['id,value', '1,same', '2,equal', ''].join('\n'),
      expected: { changed: 0, baselineOnly: 0, candidateOnly: 0, unchanged: 2, total: 2 },
    },
    {
      name: 'one row',
      baseline: ['id,value', '1,same', ''].join('\n'),
      candidate: ['id,value', '1,same', ''].join('\n'),
      expected: { changed: 0, baselineOnly: 0, candidateOnly: 0, unchanged: 1, total: 1 },
    },
    {
      name: 'every row different',
      baseline: ['id,value', '1,old-a', '2,old-b', ''].join('\n'),
      candidate: ['id,value', '1,new-a', '2,new-b', ''].join('\n'),
      expected: { changed: 2, baselineOnly: 0, candidateOnly: 0, unchanged: 0, total: 2 },
    },
  ])('summarizes $name from literal expected outcomes', async ({ baseline, candidate, expected }) => {
    const baselineCsv = await value.openSource('baseline.csv', baseline);
    const candidateCsv = await value.openSource('candidate.csv', candidate);
    const comparison = await openComparison(value, baselineCsv, candidateCsv);

    const applied = await applyKey(value, comparison.comparisonId, ['id']);

    expect(applied.applied?.summary.rows).toEqual(expected);
  });

  it('aligns a composite key with exact cells, all classifications, binary ordering, and a final partial window', async () => {
    const baseline = await value.openSource(
      'baseline.csv',
      [
        'group,id,status,code,note',
        'A,10,Same,001,"quoted, value"',
        'A,2,UPPER,02,"line one\nline two"',
        'A,3,unchanged,003,same',
        'a,1,baseline-only,004,only here',
        '',
      ].join('\n'),
    );
    const candidate = await value.openSource(
      'candidate.csv',
      [
        'note,code,status,id,group',
        '"quoted, value",1,Same,10,A',
        '"line one\nline two",02,upper,2,A',
        'same,003,unchanged,3,A',
        'only there,005,candidate-only,1,b',
        '',
      ].join('\n'),
    );
    const comparison = await openComparison(value, baseline, candidate);

    const applied = await applyKey(value, comparison.comparisonId, ['group', 'id']);

    expect(applied.applied?.summary).toEqual({
      rows: {
        changed: 2,
        baselineOnly: 1,
        candidateOnly: 1,
        unchanged: 1,
        total: 5,
      },
      changedColumns: [
        { name: 'status', changedRowCount: 1 },
        { name: 'code', changedRowCount: 1 },
        { name: 'note', changedRowCount: 0 },
      ],
    });

    const first = await readWindow(value, applied, { limit: 4, columns: 'changed-first' });
    expect(first.valueColumns).toEqual([
      { name: 'status', changedRowCount: 1 },
      { name: 'code', changedRowCount: 1 },
      { name: 'note', changedRowCount: 0 },
    ]);
    expect(first.totalRowCount).toBe(5);
    expect(first.rows.map(observableRow)).toEqual([
      {
        classification: 'changed',
        keyValues: ['A', '10'],
        baseline: ['Same', '001', 'quoted, value'],
        candidate: ['Same', '1', 'quoted, value'],
        changed: [false, true, false],
      },
      {
        classification: 'changed',
        keyValues: ['A', '2'],
        baseline: ['UPPER', '02', 'line one\nline two'],
        candidate: ['upper', '02', 'line one\nline two'],
        changed: [true, false, false],
      },
      {
        classification: 'unchanged',
        keyValues: ['A', '3'],
        baseline: ['unchanged', '003', 'same'],
        candidate: ['unchanged', '003', 'same'],
        changed: [false, false, false],
      },
      {
        classification: 'baseline-only',
        keyValues: ['a', '1'],
        baseline: ['baseline-only', '004', 'only here'],
        candidate: null,
        changed: [false, false, false],
      },
    ]);

    const final = await readWindow(value, applied, { offset: 4, limit: 4 });
    expect(final.rows.map(observableRow)).toEqual([
      {
        classification: 'candidate-only',
        keyValues: ['b', '1'],
        baseline: null,
        candidate: ['candidate-only', '005', 'only there'],
        changed: [false, false, false],
      },
    ]);

    const swapped = await value.viewer.call({ operation: 'comparison.swap', comparisonId: applied.comparisonId });
    if (swapped.status !== 'changed' || !swapped.comparison.applied) {
      throw new Error('Comparison did not swap.');
    }
    expect(swapped.comparison.baseline.workingCsvId).toBe(candidate.workingCsvId);
    const swappedWindow = await readWindow(value, swapped.comparison, {
      rows: 'all',
      columns: 'changed-first',
    });
    expect(swappedWindow.valueColumns).toEqual([
      { name: 'code', changedRowCount: 1 },
      { name: 'status', changedRowCount: 1 },
      { name: 'note', changedRowCount: 0 },
    ]);
    expect(swappedWindow.rows[0]).toMatchObject({
      classification: 'changed',
      keyValues: ['A', '10'],
      baseline: { rowId: '1', values: ['1', 'Same', 'quoted, value'] },
      candidate: { rowId: '1', values: ['001', 'Same', 'quoted, value'] },
      changed: [true, false, false],
    });
    expect(swappedWindow.rows[3]).toMatchObject({
      classification: 'candidate-only',
      keyValues: ['a', '1'],
      baseline: null,
      candidate: { values: ['004', 'baseline-only', 'only here'] },
    });
    expect(swappedWindow.rows[4]).toMatchObject({
      classification: 'baseline-only',
      keyValues: ['b', '1'],
      baseline: { values: ['005', 'candidate-only', 'only there'] },
      candidate: null,
    });
  });

  it('returns complete invalid-key counts with bounded non-overlapping evidence', async () => {
    const baseline = await value.openSource(
      'invalid-baseline.csv',
      [
        'group,id,value',
        ',blank-1,x',
        'A,,x',
        ',blank-3,x',
        'B,,x',
        ',blank-5,x',
        'C,,x',
        ',blank-7,x',
        'A,1,a1-first',
        'A,1,a1-second',
        'A,2,a2-first',
        'A,2,a2-second',
        'B,1,b1-first',
        'B,1,b1-second',
        'a,1,lower-a-first',
        'a,1,lower-a-second',
        'b,1,lower-b-first',
        'b,1,lower-b-second',
        'c,1,c-first',
        'c,1,c-second',
        'c,1,c-third',
        'c,1,c-fourth',
        'c,1,c-fifth',
        'c,1,c-sixth',
        '',
      ].join('\n'),
    );
    const candidate = await value.openSource(
      'invalid-candidate.csv',
      ['group,id,value', 'A,1,one', 'A,2,two-first', 'A,2,two-second', ',blank-candidate,x', ''].join('\n'),
    );
    const comparison = await openComparison(value, baseline, candidate);

    const started = await value.viewer.call({
      operation: 'comparison.begin',
      kind: 'apply-key',
      comparisonId: comparison.comparisonId,
      key: ['group', 'id'],
    });
    if (started.status !== 'accepted') throw new Error(`Comparison was ${started.status}.`);
    const completed = await value.awaitComparisonOutcome(started.operationId);
    if (completed.status !== 'invalid-key') {
      throw new Error(`Comparison completed as ${completed.status}.`);
    }

    expect(completed.diagnostics.baseline).toEqual({
      blankRowCount: 7,
      duplicateGroupCount: 6,
      blankExamples: [
        { rowId: '1', keyValues: [null, 'blank-1'] },
        { rowId: '2', keyValues: ['A', null] },
        { rowId: '3', keyValues: [null, 'blank-3'] },
        { rowId: '4', keyValues: ['B', null] },
        { rowId: '5', keyValues: [null, 'blank-5'] },
      ],
      duplicateExamples: [
        { keyValues: ['A', '1'], rowCount: 2, rowIds: ['8', '9'] },
        { keyValues: ['A', '2'], rowCount: 2, rowIds: ['10', '11'] },
        { keyValues: ['B', '1'], rowCount: 2, rowIds: ['12', '13'] },
        { keyValues: ['a', '1'], rowCount: 2, rowIds: ['14', '15'] },
        { keyValues: ['b', '1'], rowCount: 2, rowIds: ['16', '17'] },
      ],
    });
    expect(completed.diagnostics.candidate).toEqual({
      blankRowCount: 1,
      duplicateGroupCount: 1,
      blankExamples: [{ rowId: '4', keyValues: [null, 'blank-candidate'] }],
      duplicateExamples: [{ keyValues: ['A', '2'], rowCount: 2, rowIds: ['2', '3'] }],
    });
    expect((await comparisonState(value, comparison.comparisonId)).applied).toBeNull();
  });

  it('keeps the applied result readable when a replacement key is invalid', async () => {
    const baseline = await value.openSource('baseline.csv', 'id,name,status\n1,Ada,active\n2,Bob,old\n');
    const candidate = await value.openSource('candidate.csv', 'id,name,status\n1,Ada,active\n2,Bob,new\n');
    const comparison = await openComparison(value, baseline, candidate);
    const applied = await applyKey(value, comparison.comparisonId, ['id']);
    if (!applied.applied) throw new Error('Comparison has no applied result.');

    await value.viewer.call({
      operation: 'csv.edit-cell',
      workingCsvId: baseline.workingCsvId,
      rowId: '2',
      column: 'id',
      value: '1',
    });
    const invalid = await runComparison(value, comparison.comparisonId, ['id']);

    expect(invalid.status).toBe('invalid-key');
    expect(invalid.comparison.applied).toMatchObject({
      resultToken: applied.applied.resultToken,
      freshness: { kind: 'outdated', changedSides: ['baseline'] },
    });
    await expect(readWindow(value, invalid.comparison)).resolves.toMatchObject({
      totalRowCount: 2,
    });
  });

  it('distinguishes null, empty, case, whitespace, leading zeros, literal NULL, and quoted text exactly', async () => {
    const baseline = await value.openSource(
      'exact-baseline.csv',
      [
        'id,value',
        '1,',
        '2,NULL',
        '3,Case',
        '4," space "',
        '5,001',
        '6,"quoted, value"',
        '7,"line one\nline two"',
        '8,',
        '',
      ].join('\n'),
    );
    const candidate = await value.openSource(
      'exact-candidate.csv',
      [
        'id,value',
        '1,',
        '2,NULL',
        '3,case',
        '4,space',
        '5,1',
        '6,"quoted, value"',
        '7,"line one\nline two"',
        '8,',
        '',
      ].join('\n'),
    );
    await value.viewer.call({
      operation: 'csv.edit-cell',
      workingCsvId: candidate.workingCsvId,
      rowId: '1',
      column: 'value',
      value: '',
    });
    const comparison = await openComparison(value, baseline, candidate);

    const applied = await applyKey(value, comparison.comparisonId, ['id']);
    const window = await readWindow(value, applied);

    expect(applied.applied?.summary.rows).toEqual({
      changed: 4,
      baselineOnly: 0,
      candidateOnly: 0,
      unchanged: 4,
      total: 8,
    });
    expect(window.rows.map(observableRow)).toEqual([
      {
        classification: 'changed',
        keyValues: ['1'],
        baseline: [null],
        candidate: [''],
        changed: [true],
      },
      {
        classification: 'unchanged',
        keyValues: ['2'],
        baseline: ['NULL'],
        candidate: ['NULL'],
        changed: [false],
      },
      {
        classification: 'changed',
        keyValues: ['3'],
        baseline: ['Case'],
        candidate: ['case'],
        changed: [true],
      },
      {
        classification: 'changed',
        keyValues: ['4'],
        baseline: [' space '],
        candidate: ['space'],
        changed: [true],
      },
      {
        classification: 'changed',
        keyValues: ['5'],
        baseline: ['001'],
        candidate: ['1'],
        changed: [true],
      },
      {
        classification: 'unchanged',
        keyValues: ['6'],
        baseline: ['quoted, value'],
        candidate: ['quoted, value'],
        changed: [false],
      },
      {
        classification: 'unchanged',
        keyValues: ['7'],
        baseline: ['line one\nline two'],
        candidate: ['line one\nline two'],
        changed: [false],
      },
      {
        classification: 'unchanged',
        keyValues: ['8'],
        baseline: [null],
        candidate: [null],
        changed: [false],
      },
    ]);
  });

  it('reports compatibility and key-shape faults through typed workspace outcomes', async () => {
    const baseline = await value.openSource(
      'baseline.csv',
      ['"select","odd name","quote""name"', '1,alpha,value', ''].join('\n'),
    );
    const compatible = await value.openSource(
      'compatible.csv',
      ['"quote""name","select","odd name"', 'value,1,alpha', ''].join('\n'),
    );
    const incompatible = await value.openSource(
      'incompatible.csv',
      ['"select","odd name",extra', '1,alpha,value', ''].join('\n'),
    );

    expect(
      await value.viewer.call({ operation: 'comparison.get-candidates', baselineId: baseline.workingCsvId }),
    ).toEqual([
      { workingCsv: compatible, compatibility: { kind: 'compatible' } },
      {
        workingCsv: incompatible,
        compatibility: {
          kind: 'incompatible',
          missingFromBaseline: ['extra'],
          missingFromCandidate: ['quote"name'],
        },
      },
    ]);
    await expect(
      value.viewer.call({
        operation: 'comparison.open',
        baselineId: baseline.workingCsvId,
        candidateId: baseline.workingCsvId,
      }),
    ).resolves.toMatchObject({ status: 'rejected', fault: { code: 'same-source' } });
    await expect(
      value.viewer.call({
        operation: 'comparison.open',
        baselineId: baseline.workingCsvId,
        candidateId: incompatible.workingCsvId,
      }),
    ).resolves.toMatchObject({ status: 'rejected', fault: { code: 'incompatible-columns' } });
    await expect(
      value.viewer.call({ operation: 'comparison.open', baselineId: baseline.workingCsvId, candidateId: 'missing' }),
    ).resolves.toMatchObject({ status: 'rejected', fault: { code: 'source-not-found' } });

    const comparison = await openComparison(value, baseline, compatible);
    for (const [key, code] of [
      [[], 'invalid-key-shape'],
      [['select', 'select'], 'invalid-key-shape'],
      [['unknown'], 'unknown-key-column'],
    ] as const) {
      await expect(
        value.viewer.call({
          operation: 'comparison.begin',
          kind: 'apply-key',
          comparisonId: comparison.comparisonId,
          key: [...key],
        }),
      ).resolves.toMatchObject({ status: 'rejected', fault: { code } });
    }
    await expect(
      value.viewer.call({ operation: 'comparison.begin', kind: 'refresh', comparisonId: comparison.comparisonId }),
    ).resolves.toMatchObject({ status: 'rejected', fault: { code: 'no-applied-key' } });
  });

  it('cancels at a cooperative statement boundary without publishing a result', async () => {
    const [baseline, candidate] = await Promise.all([
      value.openSource('baseline.csv', 'id,value\n1,old\n'),
      value.openSource('candidate.csv', 'id,value\n1,new\n'),
    ]);
    const comparison = await openComparison(value, baseline, candidate);
    const summarizing = new Promise<void>((resolve) => {
      const unsubscribe = value.viewer.onEvent((viewerEvent) => {
        if (viewerEvent.type !== 'comparison') return;
        const event = viewerEvent.event;
        if (
          event.kind === 'changed' &&
          event.comparison.comparisonId === comparison.comparisonId &&
          event.comparison.operation?.phase === 'summarizing'
        ) {
          unsubscribe();
          resolve();
        }
      });
    });

    const started = await value.viewer.call({
      operation: 'comparison.begin',
      kind: 'apply-key',
      comparisonId: comparison.comparisonId,
      key: ['id'],
    });
    if (started.status !== 'accepted') throw new Error(`Comparison was ${started.status}.`);
    await summarizing;

    await expect(
      value.viewer.call({
        operation: 'comparison.cancel',
        comparisonId: comparison.comparisonId,
        operationId: started.operationId,
      }),
    ).resolves.toEqual({ status: 'requested' });
    await expect(value.awaitComparisonOutcome(started.operationId)).resolves.toEqual({
      attemptId: started.operationId,
      status: 'cancelled',
    });
    expect(value.latestComparison(comparison.comparisonId)).toMatchObject({
      operation: null,
      applied: null,
      lastAttempt: { attemptId: started.operationId, status: 'cancelled' },
    });
  });

  it('handles key-only data, zero and maximum windows, and Swap sides without recomputation', async () => {
    const [baseline, candidate] = await Promise.all([
      value.openSource('baseline.csv', ['id', '1', '2', ''].join('\n')),
      value.openSource('candidate.csv', ['id', '1', '3', ''].join('\n')),
    ]);
    const comparison = await openComparison(value, baseline, candidate);
    const applied = await applyKey(value, comparison.comparisonId, ['id']);
    if (!applied.applied) throw new Error('Comparison has no applied result.');

    expect(applied.applied.summary).toEqual({
      rows: { changed: 0, baselineOnly: 1, candidateOnly: 1, unchanged: 1, total: 3 },
      changedColumns: [],
    });
    expect(await readWindow(value, applied, { limit: 0 })).toMatchObject({
      totalRowCount: 3,
      valueColumns: [],
      rows: [],
    });
    expect(
      await value.viewer.call({
        operation: 'comparison.get-window',
        comparisonId: applied.comparisonId,
        resultToken: applied.applied.resultToken,
        offset: 0,
        limit: 1_001,
        rows: 'all',
        columns: 'csv-order',
      }),
    ).toMatchObject({ status: 'rejected', fault: { code: 'invalid-window' } });
    const maximum = await readWindow(value, applied, { limit: 1_000, rows: 'differences' });
    expect(maximum.totalRowCount).toBe(2);
    expect(maximum.rows.map(observableRow)).toEqual([
      {
        classification: 'baseline-only',
        keyValues: ['2'],
        baseline: [],
        candidate: null,
        changed: [],
      },
      {
        classification: 'candidate-only',
        keyValues: ['3'],
        baseline: null,
        candidate: [],
        changed: [],
      },
    ]);

    const oldToken = applied.applied.resultToken;
    const swapped = await value.viewer.call({ operation: 'comparison.swap', comparisonId: applied.comparisonId });
    if (swapped.status !== 'changed' || !swapped.comparison.applied) {
      throw new Error('Comparison did not swap.');
    }
    expect(swapped.comparison.baseline.workingCsvId).toBe(candidate.workingCsvId);
    expect(swapped.comparison.applied.summary.rows).toEqual({
      changed: 0,
      baselineOnly: 1,
      candidateOnly: 1,
      unchanged: 1,
      total: 3,
    });
    expect(swapped.comparison.applied.resultToken).not.toBe(oldToken);
    expect(
      await value.viewer.call({
        operation: 'comparison.get-window',
        comparisonId: applied.comparisonId,
        resultToken: oldToken,
        offset: 0,
        limit: 100,
        rows: 'all',
        columns: 'csv-order',
      }),
    ).toEqual({
      status: 'result-replaced',
      currentResultToken: swapped.comparison.applied.resultToken,
    });
    expect((await readWindow(value, swapped.comparison, { rows: 'differences' })).rows.map(observableRow)).toEqual([
      {
        classification: 'candidate-only',
        keyValues: ['2'],
        baseline: null,
        candidate: [],
        changed: [],
      },
      {
        classification: 'baseline-only',
        keyValues: ['3'],
        baseline: [],
        candidate: null,
        changed: [],
      },
    ]);
  });

  it('closes dependent Comparisons and releases their published results with a CSV Source', async () => {
    const [baseline, candidate] = await Promise.all([
      value.openSource('baseline.csv', 'id,value\n1,old\n'),
      value.openSource('candidate.csv', 'id,value\n1,new\n'),
    ]);
    const comparison = await openComparison(value, baseline, candidate);
    const applied = await applyKey(value, comparison.comparisonId, ['id']);
    if (!applied.applied) throw new Error('Comparison has no applied result.');

    const confirmation = await value.viewer.call({ operation: 'csv.close', workingCsvId: baseline.workingCsvId });
    if (confirmation.status !== 'confirmation-required') {
      throw new Error(`CSV Source close completed as ${confirmation.status}.`);
    }

    await expect(
      value.viewer.call({
        operation: 'csv.close',
        workingCsvId: baseline.workingCsvId,
        confirmedImpact: confirmation.impact,
      }),
    ).resolves.toEqual({
      status: 'closed',
      closedWorkingCsvId: baseline.workingCsvId,
      closedComparisonIds: [comparison.comparisonId],
    });
    expect(value.latestComparison(comparison.comparisonId)).toBeNull();
    await expect(
      value.viewer.call({
        operation: 'comparison.get-window',
        comparisonId: comparison.comparisonId,
        resultToken: applied.applied.resultToken,
        offset: 0,
        limit: 100,
        rows: 'all',
        columns: 'csv-order',
      }),
    ).resolves.toEqual({ status: 'comparison-not-found' });
  });

  it('publishes no changed event after closing a running Comparison', async () => {
    const [baseline, candidate] = await Promise.all([
      value.openSource('baseline.csv', 'id,value\n1,a\n2,b\n'),
      value.openSource('candidate.csv', 'id,value\n1,a\n2,c\n'),
    ]);
    const comparison = await openComparison(value, baseline, candidate);
    const events: string[] = [];
    const unsubscribe = value.viewer.onEvent((event) => {
      if (event.type === 'comparison') events.push(event.event.kind);
    });

    await value.viewer.call({
      operation: 'comparison.begin',
      kind: 'apply-key',
      comparisonId: comparison.comparisonId,
      key: ['id'],
    });
    await expect(
      value.viewer.call({ operation: 'comparison.close', comparisonId: comparison.comparisonId }),
    ).resolves.toEqual({ status: 'closed', comparisonId: comparison.comparisonId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    unsubscribe();

    expect(events.at(-1)).toBe('closed');
    expect(value.latestComparison(comparison.comparisonId)).toBeNull();
  });

  it('marks every Working CSV data mutation Outdated while queries and Export CSV remain current', async () => {
    const baseline = await value.openSource('baseline.csv', ['id,value', '1,old', ''].join('\n'));
    const candidate = await value.openSource('candidate.csv', ['id,value', '1,new', ''].join('\n'));
    const comparison = await openComparison(value, baseline, candidate);
    let applied = await applyKey(value, comparison.comparisonId, ['id']);
    if (!applied.applied) throw new Error('Comparison has no applied result.');
    const resultToken = applied.applied.resultToken;

    await value.viewer.call({
      operation: 'csv.get-rows',
      workingCsvId: baseline.workingCsvId,
      offset: 0,
      limit: 100,
      sort: [{ column: 'value', direction: 'desc' }],
      filters: [{ column: 'value', kind: 'text', operator: 'contains', value: 'old' }],
      search: 'old',
    });
    await value.viewer.call({
      operation: 'csv.get-column-value-counts',
      workingCsvId: baseline.workingCsvId,
      column: 'value',
      search: 'old',
    });
    value.captureNextExport('exported-copy.csv');
    await value.viewer.call({ operation: 'csv.export', workingCsvId: baseline.workingCsvId });
    expect((await comparisonState(value, comparison.comparisonId)).applied).toMatchObject({
      resultToken,
      freshness: { kind: 'current' },
    });

    await value.viewer.call({
      operation: 'csv.edit-cell',
      workingCsvId: baseline.workingCsvId,
      rowId: '1',
      column: 'value',
      value: 'edited',
    });
    expect((await comparisonState(value, comparison.comparisonId)).applied).toMatchObject({
      resultToken,
      freshness: { kind: 'outdated', changedSides: ['baseline'] },
    });
    applied = await refresh(value, comparison.comparisonId);
    expect(applied.applied?.freshness).toEqual({ kind: 'current' });

    await value.viewer.call({ operation: 'csv.undo', workingCsvId: baseline.workingCsvId });
    expect((await comparisonState(value, comparison.comparisonId)).applied?.freshness).toEqual({
      kind: 'outdated',
      changedSides: ['baseline'],
    });
    await refresh(value, comparison.comparisonId);

    await value.viewer.call({ operation: 'csv.redo', workingCsvId: baseline.workingCsvId });
    expect((await comparisonState(value, comparison.comparisonId)).applied?.freshness).toEqual({
      kind: 'outdated',
      changedSides: ['baseline'],
    });
    await refresh(value, comparison.comparisonId);

    await value.viewer.call({
      operation: 'csv.insert-row',
      workingCsvId: baseline.workingCsvId,
      placement: 'append',
      rowIds: [],
      hasActiveQuery: false,
    });
    expect((await comparisonState(value, comparison.comparisonId)).applied?.freshness).toEqual({
      kind: 'outdated',
      changedSides: ['baseline'],
    });
    await value.viewer.call({ operation: 'csv.undo', workingCsvId: baseline.workingCsvId });
    await refresh(value, comparison.comparisonId);

    await value.viewer.call({ operation: 'csv.delete-rows', workingCsvId: baseline.workingCsvId, rowIds: ['1'] });
    expect((await comparisonState(value, comparison.comparisonId)).applied?.freshness).toEqual({
      kind: 'outdated',
      changedSides: ['baseline'],
    });
    await refresh(value, comparison.comparisonId);
    await value.viewer.call({ operation: 'csv.undo', workingCsvId: baseline.workingCsvId });
    expect((await comparisonState(value, comparison.comparisonId)).applied?.freshness).toEqual({
      kind: 'outdated',
      changedSides: ['baseline'],
    });
    await refresh(value, comparison.comparisonId);

    await value.writeSource('baseline.csv', ['id,value', '1,replaced', ''].join('\n'));
    const replacement = await value.viewer.call({ operation: 'csv.reopen', workingCsvId: baseline.workingCsvId });
    expect(replacement).toMatchObject({
      status: 'opened',
      workingCsv: { workingCsvId: baseline.workingCsvId },
    });
    expect((await comparisonState(value, comparison.comparisonId)).applied?.freshness).toEqual({
      kind: 'outdated',
      changedSides: ['baseline'],
    });
  });
});
