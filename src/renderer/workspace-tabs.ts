import type {
  ComparisonColumnsMode,
  ComparisonEvent,
  ComparisonId,
  ComparisonRowsMode,
  ComparisonView,
  WorkingCsvView,
  WorkingCsvId,
} from '../shared/csv-viewer-contract';
import type { OpenRendererTab } from './components/tab-strip';

export type ComparisonTabPresentation = {
  draftKey: string[];
  rows: ComparisonRowsMode;
  columns: ComparisonColumnsMode;
};

export type RendererTab =
  | { kind: 'csv'; id: string; csv: WorkingCsvView }
  | {
      kind: 'comparison';
      id: string;
      comparisonId: ComparisonId;
      presentation: ComparisonTabPresentation;
    };

export type RendererWorkspaceState = {
  tabs: RendererTab[];
  comparisons: ReadonlyMap<ComparisonId, ComparisonView>;
  activeTabId: string | null;
};

export type RendererWorkspaceAction =
  | { type: 'open-csv'; workingCsv: WorkingCsvView }
  | { type: 'close-csv'; workingCsvId: WorkingCsvId }
  | { type: 'open-comparison'; comparison: ComparisonView }
  | { type: 'comparison-event'; event: ComparisonEvent }
  | {
      type: 'update-comparison-presentation';
      comparisonId: ComparisonId;
      presentation: ComparisonTabPresentation;
    }
  | { type: 'select'; tabId: string }
  | { type: 'cycle'; direction: 1 | -1 };

export const initialRendererWorkspace: RendererWorkspaceState = {
  tabs: [],
  comparisons: new Map(),
  activeTabId: null,
};

export const csvTabId = (workingCsvId: WorkingCsvId) => `csv:${workingCsvId}`;
export const comparisonTabId = (comparisonId: ComparisonId) => `comparison:${comparisonId}`;

export function rendererWorkspaceReducer(
  state: RendererWorkspaceState,
  action: RendererWorkspaceAction,
): RendererWorkspaceState {
  switch (action.type) {
    case 'open-csv': {
      const id = csvTabId(action.workingCsv.workingCsvId);
      const existingIndex = state.tabs.findIndex(
        (tab) =>
          tab.kind === 'csv' &&
          (tab.csv.workingCsvId === action.workingCsv.workingCsvId ||
            tab.csv.file.sourceId === action.workingCsv.file.sourceId),
      );
      const tabs = [...state.tabs];
      if (existingIndex === -1) tabs.push({ kind: 'csv', id, csv: action.workingCsv });
      else tabs[existingIndex] = { kind: 'csv', id, csv: action.workingCsv };
      return { ...state, tabs, activeTabId: id };
    }
    case 'close-csv':
      return removeTab(state, csvTabId(action.workingCsvId));
    case 'open-comparison': {
      const comparison = action.comparison;
      const id = comparisonTabId(comparison.comparisonId);
      const comparisons = withComparison(state.comparisons, comparison);
      if (state.tabs.some((tab) => tab.id === id)) {
        return { ...state, comparisons, activeTabId: id };
      }
      return {
        ...state,
        comparisons,
        tabs: [
          ...state.tabs,
          {
            kind: 'comparison',
            id,
            comparisonId: comparison.comparisonId,
            presentation: {
              draftKey: comparison.applied?.key ?? [],
              rows: 'differences',
              columns: 'changed-first',
            },
          },
        ],
        activeTabId: id,
      };
    }
    case 'comparison-event': {
      if (action.event.kind === 'closed') {
        const comparisons = new Map(state.comparisons);
        comparisons.delete(action.event.comparisonId);
        return removeTab({ ...state, comparisons }, comparisonTabId(action.event.comparisonId));
      }
      const existing = state.comparisons.get(action.event.comparison.comparisonId);
      if (existing && existing.version >= action.event.comparison.version) return state;
      return {
        ...state,
        comparisons: withComparison(state.comparisons, action.event.comparison),
      };
    }
    case 'update-comparison-presentation':
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.kind === 'comparison' && tab.comparisonId === action.comparisonId
            ? { ...tab, presentation: action.presentation }
            : tab,
        ),
      };
    case 'select':
      return state.tabs.some((tab) => tab.id === action.tabId)
        ? { ...state, activeTabId: action.tabId }
        : state;
    case 'cycle': {
      if (state.tabs.length < 2 || !state.activeTabId) return state;
      const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
      if (index === -1) return state;
      const nextIndex = (index + action.direction + state.tabs.length) % state.tabs.length;
      return { ...state, activeTabId: state.tabs[nextIndex].id };
    }
  }
}

export function projectOpenTabs(state: RendererWorkspaceState): OpenRendererTab[] {
  const openTabs: OpenRendererTab[] = [];
  for (const tab of state.tabs) {
    if (tab.kind === 'csv') {
      openTabs.push({ kind: 'csv', id: tab.id, csv: tab.csv });
      continue;
    }
    const comparison = state.comparisons.get(tab.comparisonId);
    if (!comparison) {
      console.error(`Renderer Comparison Tab ${tab.comparisonId} has no projection.`);
      continue;
    }
    openTabs.push({ kind: 'comparison', id: tab.id, comparison });
  }
  return openTabs;
}

function withComparison(
  comparisons: ReadonlyMap<ComparisonId, ComparisonView>,
  comparison: ComparisonView,
): ReadonlyMap<ComparisonId, ComparisonView> {
  const next = new Map(comparisons);
  next.set(comparison.comparisonId, comparison);
  return next;
}

function removeTab(state: RendererWorkspaceState, id: string): RendererWorkspaceState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const activeTabId =
    state.activeTabId === id ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? null) : state.activeTabId;
  return { ...state, tabs, activeTabId };
}
