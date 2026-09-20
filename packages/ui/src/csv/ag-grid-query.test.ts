import { describe, expect, it } from 'vitest';
import { toCsvFilterDescriptors, toCsvSortDescriptors, remapAgColumnState, remapAgFilterModel, renamedColumnName } from './ag-grid-query';

describe('AG Grid query translation', () => {
  it('maps sort and AND-combined filters, and drops OR-combined filters whole', () => {
    expect(toCsvSortDescriptors([{ colId: 'age', sort: 'desc' }])).toEqual([{ column: 'age', direction: 'desc' }]);

    expect(
      toCsvFilterDescriptors({
        name: { filterType: 'text', type: 'contains', filter: 'Ada' },
        age: {
          operator: 'AND',
          conditions: [
            { filterType: 'number', type: 'greaterThan', filter: 30 },
            { filterType: 'number', type: 'blank' },
          ],
        },
        city: {
          operator: 'OR',
          conditions: [
            { filterType: 'text', type: 'equals', filter: 'Paris' },
            { filterType: 'text', type: 'equals', filter: 'Rome' },
          ],
        },
      }),
    ).toEqual([
      { column: 'name', kind: 'text', operator: 'contains', value: 'Ada' },
      { column: 'age', kind: 'number', operator: 'greaterThan', value: 30, valueTo: undefined },
      { column: 'age', kind: 'number', operator: 'blank' },
    ]);
  });

  it('remaps sort and filter keys across a single column rename', () => {
    expect(renamedColumnName(['id', 'email', 'status'], ['id', 'work_email', 'status'])).toEqual({
      from: 'email',
      to: 'work_email',
    });
    expect(renamedColumnName(['id', 'email'], ['id', 'email'])).toBeNull();
    expect(remapAgColumnState([{ colId: 'email', sort: 'asc' as const }, { colId: 'name' }], 'email', 'work_email')).toEqual([
      { colId: 'work_email', sort: 'asc' },
      { colId: 'name' },
    ]);
    expect(
      remapAgFilterModel({ email: { filterType: 'text', type: 'contains', filter: 'ada' }, name: { filterType: 'text', type: 'equals', filter: 'Ada' } }, 'email', 'work_email'),
    ).toEqual({
      work_email: { filterType: 'text', type: 'contains', filter: 'ada' },
      name: { filterType: 'text', type: 'equals', filter: 'Ada' },
    });
  });
});
