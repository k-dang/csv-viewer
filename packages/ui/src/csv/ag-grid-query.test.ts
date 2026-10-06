import { describe, expect, it } from 'vitest';
import { toAgFilterModel, toAgSortState, toCsvFilterDescriptors, toCsvSortDescriptors } from './ag-grid-query';

describe('AG Grid query translation', () => {
  it('maps sort, Value Filters, and AND-combined filters, and drops OR-combined filters whole', () => {
    expect(toCsvSortDescriptors([{ colId: 'age', sort: 'desc' }])).toEqual([{ column: 'age', direction: 'desc' }]);

    expect(
      toCsvFilterDescriptors({
        name: { filterType: 'values', contains: 'Ada', pick: { operator: 'notIn', values: [null] } },
        team: { filterType: 'values', pick: { operator: 'in', values: ['compiler'] } },
        age: {
          operator: 'AND',
          conditions: [
            { filterType: 'number', type: 'greaterThan', filter: 30 },
            { filterType: 'number', type: 'blank' },
          ],
        },
        score: {
          operator: 'OR',
          conditions: [
            { filterType: 'number', type: 'equals', filter: 1 },
            { filterType: 'number', type: 'equals', filter: 2 },
          ],
        },
      }),
    ).toEqual([
      { column: 'name', kind: 'text', operator: 'contains', value: 'Ada' },
      { column: 'name', kind: 'values', operator: 'notIn', values: [null] },
      { column: 'team', kind: 'values', operator: 'in', values: ['compiler'] },
      { column: 'age', kind: 'number', operator: 'greaterThan', value: 30, valueTo: undefined },
      { column: 'age', kind: 'number', operator: 'blank' },
    ]);
  });

  it('translates sort and filter descriptors to AG Grid models', () => {
    expect(toAgSortState([{ column: 'work_email', direction: 'asc' }])).toEqual([
      { colId: 'work_email', sort: 'asc', sortIndex: 0 },
    ]);
    expect(
      toAgFilterModel([
        { column: 'work_email', kind: 'text', operator: 'contains', value: 'ada' },
        { column: 'work_email', kind: 'values', operator: 'in', values: ['ada@example.com', ''] },
        { column: 'age', kind: 'number', operator: 'greaterThan', value: 30 },
        { column: 'age', kind: 'number', operator: 'blank' },
      ]),
    ).toEqual({
      work_email: { filterType: 'values', contains: 'ada', pick: { operator: 'in', values: ['ada@example.com', ''] } },
      age: {
        operator: 'AND',
        conditions: [
          { filterType: 'number', type: 'greaterThan', filter: 30, filterTo: undefined },
          { filterType: 'number', type: 'blank', filter: undefined, filterTo: undefined },
        ],
      },
    });
  });
});
