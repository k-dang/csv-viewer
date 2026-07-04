import type { IDatasource, IGetRowsParams } from 'ag-grid-community';
import type {
  CsvDateFilterOperator,
  CsvFilterDescriptor,
  CsvNumberFilterOperator,
  CsvSessionMetadata,
  CsvSortDescriptor,
  CsvTextFilterOperator,
  CsvViewerApi,
} from '../../shared/ipc';

export function createCsvGridDataSource(
  session: CsvSessionMetadata,
  api: Pick<CsvViewerApi, 'getCsvRows'>,
  onFilteredRowCount?: (rowCount: number) => void,
  search = '',
  requestState: { latestRequestId: number } = { latestRequestId: 0 },
  onQueryState?: (state: 'querying' | 'ready' | 'failed') => void,
): IDatasource {
  return {
    rowCount: session.rowCount,
    getRows: (params: IGetRowsParams) => {
      const requestId = requestState.latestRequestId + 1;
      requestState.latestRequestId = requestId;
      const offset = params.startRow;
      const limit = Math.max(0, params.endRow - params.startRow);
      const query = {
        sort: toCsvSortDescriptors(params.sortModel),
        filters: toCsvFilterDescriptors(params.filterModel),
        search: search.trim(),
      };

      onQueryState?.('querying');

      api
        .getCsvRows({ sessionId: session.sessionId, offset, limit, ...query })
        .then((window) => {
          if (requestId !== requestState.latestRequestId) {
            return;
          }

          onFilteredRowCount?.(window.filteredRowCount);
          onQueryState?.('ready');
          params.successCallback(window.rows, window.filteredRowCount);
        })
        .catch(() => {
          if (requestId !== requestState.latestRequestId) {
            return;
          }

          onQueryState?.('failed');
          params.failCallback();
        });
    },
  };
}

type AgSortModelItem = {
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

export function toCsvFilterDescriptors(filterModel: AgFilterModel): CsvFilterDescriptor[] {
  return Object.entries(filterModel).flatMap(([column, model]) => {
    if (isCombinedFilter(model)) {
      if (model.operator === 'OR') {
        return [];
      }

      return (model.conditions ?? []).flatMap((condition) => toCsvFilterDescriptor(column, condition));
    }

    return toCsvFilterDescriptor(column, model);
  });
}

function isCombinedFilter(model: AgFilterCondition | AgCombinedFilter): model is AgCombinedFilter {
  return Array.isArray((model as AgCombinedFilter).conditions);
}

function toCsvFilterDescriptor(column: string, model: AgFilterCondition): CsvFilterDescriptor[] {
  const type = model.type;

  if (type === 'blank' || type === 'notBlank') {
    const kind = model.filterType === 'number' || model.filterType === 'date' ? model.filterType : 'text';
    return [{ column, kind, operator: type }] as CsvFilterDescriptor[];
  }

  if (model.filterType === 'number') {
    return [
      {
        column,
        kind: 'number',
        operator: toNumberOperator(type),
        value: typeof model.filter === 'number' ? model.filter : Number(model.filter),
        valueTo:
          model.filterTo === null || model.filterTo === undefined ? undefined : Number(model.filterTo),
      },
    ];
  }

  if (model.filterType === 'date') {
    return [
      {
        column,
        kind: 'date',
        operator: toDateOperator(type),
        value: model.dateFrom ?? undefined,
        valueTo: model.dateTo ?? undefined,
      },
    ];
  }

  return [
    {
      column,
      kind: 'text',
      operator: toTextOperator(type),
      value: String(model.filter ?? ''),
    },
  ];
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

function toDateOperator(type: string | undefined): CsvDateFilterOperator {
  return toNumberOperator(type);
}
