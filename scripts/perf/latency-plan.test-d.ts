import type { Interval, TimedMark } from './latency-plan.ts';

// @ts-expect-error Edit text renders before csv.edit-cell returns, so edit-cell cannot stop on a cell.
export const editStopsOnCell: TimedMark<'edit-cell'> = { kind: 'cell', row: 0, column: 'name', text: 'Ada Lovelace edited' };

// @ts-expect-error A filter clock from the input runs through the filter debounce and must say so.
export const unlabelledDebounce: Interval<'filter'> = { from: 'input', to: 'cell' };
