import type {
  CsvFilterDescriptor,
  CsvNumberFilterOperator,
  CsvSortDescriptor,
  CsvTextFilterOperator,
} from '@csv-viewer/workspace/csv-viewer';

/** Translates AG Grid's sort and filter models into CsvViewer descriptors. View-side only. */

export type AgSortModelItem = {
  colId: string;
  sort: 'asc' | 'desc';
};

export type AgFilterModel = Record<string, AgFilterCondition | AgCombinedFilter>;

type AgCombinedFilter = {
  operator?: 'AND' | 'OR';
  conditions?: AgFilterCondition[];
};

type AgFilterCondition = {
  filterType?: 'text' | 'number' | 'date';
  type?: string;
  filter?: string | number | null;
  filterTo?: string | number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
};

export function toCsvSortDescriptors(sortModel: AgSortModelItem[]): CsvSortDescriptor[] {
  return sortModel.map((item) => ({
    column: item.colId,
    direction: item.sort,
  }));
}

/**
 * OR-combined conditions have no CsvViewer descriptor and are dropped for the whole column, so an
 * OR filter narrows neither the row window nor the Count Scope. AND conditions map one to one.
 */
export function toCsvFilterDescriptors(filterModel: AgFilterModel): CsvFilterDescriptor[] {
  return Object.entries(filterModel).flatMap(([column, model]) => {
    if (isCombinedFilter(model)) {
      if (model.operator === 'OR') {
        return [];
      }

      return (model.conditions ?? []).map((condition) => toCsvFilterDescriptor(column, condition));
    }

    return [toCsvFilterDescriptor(column, model)];
  });
}

function isCombinedFilter(model: AgFilterCondition | AgCombinedFilter): model is AgCombinedFilter {
  return 'conditions' in model && Array.isArray(model.conditions);
}

function toCsvFilterDescriptor(column: string, model: AgFilterCondition): CsvFilterDescriptor {
  const type = model.type;

  if (type === 'blank' || type === 'notBlank') {
    const kind = model.filterType === 'number' || model.filterType === 'date' ? model.filterType : 'text';
    return { column, kind, operator: type };
  }

  if (model.filterType === 'number') {
    return {
      column,
      kind: 'number',
      operator: toNumberOperator(type),
      value: Number(model.filter),
      valueTo: model.filterTo === null || model.filterTo === undefined ? undefined : Number(model.filterTo),
    };
  }

  if (model.filterType === 'date') {
    return {
      column,
      kind: 'date',
      // Date and number filters share AG Grid's comparison operator names.
      operator: toNumberOperator(type),
      value: model.dateFrom ?? undefined,
      valueTo: model.dateTo ?? undefined,
    };
  }

  return { column, kind: 'text', operator: toTextOperator(type), value: String(model.filter ?? '') };
}

function toTextOperator(type: string | undefined): CsvTextFilterOperator {
  if (
    type === 'contains' ||
    type === 'notContains' ||
    type === 'equals' ||
    type === 'notEqual' ||
    type === 'startsWith' ||
    type === 'endsWith'
  ) {
    return type;
  }

  return 'contains';
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
