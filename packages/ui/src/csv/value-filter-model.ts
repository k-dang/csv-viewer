import type { CsvCellValue, CsvValuesFilterOperator } from '@csv-viewer/workspace/csv-viewer';

/**
 * The model of the Value Filter on text columns: a contains term and an exact-value pick, combined
 * with AND. A filter with neither has no model at all, so an absent model means "every row".
 */
export type ValueFilterModel = {
  filterType: 'values';
  contains?: string;
  pick?: ValuePick;
};

/** `in` keeps only the listed values; `notIn` hides them. No pick keeps every value. */
export type ValuePick = { operator: CsvValuesFilterOperator; values: CsvCellValue[] };

/** The model for a contains term and a pick, or null when it neither searches nor picks. */
export function valueFilter(contains: string, pick: ValuePick | undefined): ValueFilterModel | null {
  if (!contains && !pick) return null;
  const model: ValueFilterModel = { filterType: 'values' };
  if (contains) model.contains = contains;
  if (pick) model.pick = pick;
  return model;
}

/** Whether rows holding `value` pass the pick. */
export function isValuePicked(pick: ValuePick | undefined, value: CsvCellValue): boolean {
  if (!pick) return true;
  return pick.values.includes(value) === (pick.operator === 'in');
}

/**
 * The pick after checking or unchecking one value. Unchecking from "every value" hides just that
 * value, so values beyond the listed ones keep passing; a pick that hides nothing is dropped.
 */
export function setValuePicked(pick: ValuePick | undefined, value: CsvCellValue, picked: boolean): ValuePick | undefined {
  if (isValuePicked(pick, value) === picked) return pick;
  if (!pick) return { operator: 'notIn', values: [value] };
  const adds = (pick.operator === 'in') === picked;
  const values = adds ? [...pick.values, value] : pick.values.filter((candidate) => candidate !== value);
  return pick.operator === 'notIn' && values.length === 0 ? undefined : { operator: pick.operator, values };
}

/** "Select all" reads checked with no pick, unchecked when nothing passes, and mixed otherwise. */
export function selectAllState(pick: ValuePick | undefined): 'all' | 'none' | 'some' {
  if (!pick) return 'all';
  return pick.operator === 'in' && pick.values.length === 0 ? 'none' : 'some';
}
