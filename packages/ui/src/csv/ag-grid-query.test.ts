import { describe, expect, it } from 'vitest';
import { toCsvFilterDescriptors, toCsvSortDescriptors } from './ag-grid-query';

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
});
