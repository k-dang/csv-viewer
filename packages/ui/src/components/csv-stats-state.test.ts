import { describe, expect, it } from 'vitest';
import { resolveStatsColumnOnOpen } from './csv-stats-state';

const columns = [
  { name: 'name', type: 'VARCHAR' },
  { name: 'status', type: 'VARCHAR' },
  { name: 'score', type: 'VARCHAR' },
];

describe('resolveStatsColumnOnOpen', () => {
  it('uses the focused grid column when available', () => {
    expect(
      resolveStatsColumnOnOpen({
        columns,
        currentColumn: 'name',
        focusedColumn: 'status',
      }),
    ).toBe('status');
  });

  it('keeps the current stats column when no grid column is focused', () => {
    expect(
      resolveStatsColumnOnOpen({
        columns,
        currentColumn: 'score',
        focusedColumn: null,
      }),
    ).toBe('score');
  });

  it('falls back to the first CSV column when the current column is stale for a new session', () => {
    expect(
      resolveStatsColumnOnOpen({
        columns,
        currentColumn: 'previous-file-column',
        focusedColumn: null,
      }),
    ).toBe('name');
  });
});
