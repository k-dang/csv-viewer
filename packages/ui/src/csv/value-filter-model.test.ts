import { describe, expect, it } from 'vitest';
import { isValuePicked, selectAllState, setValuePicked, valueFilter } from './value-filter-model';

describe('Value Filter picks', () => {
  it('unchecks from every value by hiding just that value, and drops a pick that hides nothing', () => {
    const hidden = setValuePicked(undefined, 'Ada', false);
    expect(hidden).toEqual({ operator: 'notIn', values: ['Ada'] });
    expect(isValuePicked(hidden, 'Ada')).toBe(false);
    expect(isValuePicked(hidden, 'Grace')).toBe(true);
    expect(setValuePicked(hidden, 'Ada', true)).toBeUndefined();
  });

  it('checks values back into an `in` pick and keeps an empty `in` pick as nothing selected', () => {
    const one = setValuePicked({ operator: 'in', values: [] }, null, true);
    expect(one).toEqual({ operator: 'in', values: [null] });
    expect(isValuePicked(one, null)).toBe(true);
    expect(isValuePicked(one, '')).toBe(false);
    const none = setValuePicked(one, null, false);
    expect(none).toEqual({ operator: 'in', values: [] });
    expect(selectAllState(none)).toBe('none');
    expect(selectAllState(one)).toBe('some');
    expect(selectAllState(undefined)).toBe('all');
  });

  it('builds no model without a search term or pick', () => {
    expect(valueFilter('', undefined)).toBeNull();
    expect(valueFilter('ad', undefined)).toEqual({ filterType: 'values', contains: 'ad' });
  });
});
