import type {
  CsvFilterDescriptor,
  CsvNumberFilterOperator,
  CsvSortDescriptor,
} from '@csv-viewer/workspace/csv-viewer';
import { valueFilter, type ValueFilterModel } from './value-filter-model';

/** Translates AG Grid's sort and filter models into CsvViewer descriptors. View-side only. */

export type AgSortModelItem = {
  colId: string;
  sort: 'asc' | 'desc';
};

export type AgFilterModel = Record<string, AgFilterCondition | AgCombinedFilter | ValueFilterModel>;

type AgCombinedFilter = {
  operator?: 'AND' | 'OR';
  conditions?: AgFilterCondition[];
};

type AgFilterCondition = {
  filterType?: 'number' | 'date';
  type?: string;
  filter?: number | null;
  filterTo?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
};

export function toCsvSortDescriptors(sortModel: AgSortModelItem[]): CsvSortDescriptor[] {
  return sortModel.map((item) => ({
    column: item.colId,
    direction: item.sort,
  }));
}

export function toAgSortState(sort: CsvSortDescriptor[]) {
  return sort.map((item, sortIndex) => ({
    colId: item.column,
    sort: item.direction,
    sortIndex,
  }));
}

export function toAgFilterModel(filters: CsvFilterDescriptor[]) {
  const grouped = new Map<string, CsvFilterDescriptor[]>();
  for (const filter of filters) {
    const list = grouped.get(filter.column) ?? [];
    list.push(filter);
    grouped.set(filter.column, list);
  }

  const model: AgFilterModel = {};
  for (const [column, list] of grouped) {
    const folded = foldValueFilter(list);
    if (folded) {
      model[column] = folded;
      continue;
    }
    const conditions = list.map(toAgFilterCondition);
    model[column] = conditions.length === 1 ? conditions[0] : { operator: 'AND', conditions };
  }
  return model;
}

/** Text and values descriptors only come from a Value Filter, so they fold back into one model. */
function foldValueFilter(list: CsvFilterDescriptor[]): ValueFilterModel | null {
  let contains = '';
  let pick: ValueFilterModel['pick'];
  for (const filter of list) {
    if (filter.kind === 'text') contains = filter.value;
    else if (filter.kind === 'values') pick = { operator: filter.operator, values: [...filter.values] };
  }
  return valueFilter(contains, pick);
}

function toAgFilterCondition(filter: CsvFilterDescriptor): AgFilterCondition {
  switch (filter.kind) {
    case 'number':
      return {
        filterType: 'number',
        type: filter.operator,
        filter: filter.value,
        filterTo: filter.valueTo,
      };
    case 'date':
      return {
        filterType: 'date',
        type: filter.operator,
        dateFrom: filter.value ?? null,
        dateTo: filter.valueTo ?? null,
      };
    case 'text':
    case 'values':
      throw new Error('Value Filter descriptors fold into one model before reaching AG Grid conditions.');
    default: {
      const exhaustive: never = filter;
      throw new Error(`Unsupported CSV filter kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * OR-combined conditions have no CsvViewer descriptor and are dropped for the whole column, so an
 * OR filter narrows neither the row window nor the Count Scope. AND conditions map one to one.
 */
export function toCsvFilterDescriptors(filterModel: AgFilterModel): CsvFilterDescriptor[] {
  return Object.entries(filterModel).flatMap(([column, model]) => {
    if (isValueFilterModel(model)) return valueFilterDescriptors(column, model);

    if (isCombinedFilter(model)) {
      if (model.operator === 'OR') {
        return [];
      }

      return (model.conditions ?? []).map((condition) => toCsvFilterDescriptor(column, condition));
    }

    return [toCsvFilterDescriptor(column, model)];
  });
}

/** The descriptors one column's Value Filter model narrows rows with. */
function valueFilterDescriptors(column: string, model: ValueFilterModel): CsvFilterDescriptor[] {
  const descriptors: CsvFilterDescriptor[] = [];
  if (model.contains) descriptors.push({ column, kind: 'text', operator: 'contains', value: model.contains });
  if (model.pick) descriptors.push({ column, kind: 'values', ...model.pick });
  return descriptors;
}

function isValueFilterModel(model: AgFilterCondition | AgCombinedFilter | ValueFilterModel): model is ValueFilterModel {
  return 'filterType' in model && model.filterType === 'values';
}

function isCombinedFilter(model: AgFilterCondition | AgCombinedFilter): model is AgCombinedFilter {
  return 'conditions' in model && Array.isArray(model.conditions);
}

function toCsvFilterDescriptor(column: string, model: AgFilterCondition): CsvFilterDescriptor {
  const type = model.type;
  const kind = model.filterType === 'date' ? 'date' : 'number';

  if (type === 'blank' || type === 'notBlank') {
    return { column, kind, operator: type };
  }

  if (kind === 'number') {
    return {
      column,
      kind,
      operator: toNumberOperator(type),
      value: Number(model.filter),
      valueTo: model.filterTo === null || model.filterTo === undefined ? undefined : Number(model.filterTo),
    };
  }

  return {
    column,
    kind,
    // Date and number filters share AG Grid's comparison operator names.
    operator: toNumberOperator(type),
    value: model.dateFrom ?? undefined,
    valueTo: model.dateTo ?? undefined,
  };
}

function toNumberOperator(type: string | undefined): CsvNumberFilterOperator {
  if (
    type === 'equals' ||
    type === 'notEqual' ||
    type === 'greaterThan' ||
    type === 'greaterThanOrEqual' ||
    type === 'lessThan' ||
    type === 'lessThanOrEqual' ||
    type === 'inRange'
  ) {
    return type;
  }

  return 'equals';
}
