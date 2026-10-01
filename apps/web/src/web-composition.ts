import { createCsvViewer, type CsvWorkspaceOwner } from '@csv-viewer/workspace/csv-workspace';
import type {
  CsvCapacityExceeded,
  CsvSourceId,
} from '@csv-viewer/workspace/csv-viewer';
import type { WorkspaceDiagnostics } from '@csv-viewer/workspace/workspace-diagnostics';
import { DuckDbWasmWorkspaceDatabase } from './duckdb-wasm-database';
import type { WebCsvCapacityLimits, WebCsvFilePicker } from './web-workspace-host';
import { WebWorkspaceHost } from './web-workspace-host';

export type WebCsvViewerStartup =
  | { status: 'ready'; viewer: CsvWorkspaceOwner; acquireDroppedSource: (file: File) => Promise<CsvSourceId | CsvCapacityExceeded> }
  | { status: 'unsupported' };

export interface WebCsvViewerOptions {
  readonly limits?: WebCsvCapacityLimits;
  /** Aborting it, as page hide does, interrupts a pending startup. */
  readonly signal?: AbortSignal;
  readonly diagnostics?: WorkspaceDiagnostics;
}

/** Acquires the pinned Worker, which proves its in-memory CSV path, before file selection is enabled. */
export async function startWebCsvViewer(
  database: DuckDbWasmWorkspaceDatabase,
  pickFile: WebCsvFilePicker,
  { limits, signal, diagnostics }: WebCsvViewerOptions = {},
): Promise<WebCsvViewerStartup> {
  try {
    const host = new WebWorkspaceHost(database, pickFile, limits);
    const workspace = await createCsvViewer(database.open(), host, {
      diagnostics,
      startup: {
        signal,
        stopped: database.stopped,
        check: database.verifyInMemoryCsvQuery(),
        cleanup: database.closeStartup(),
        observeLateCleanupFailure: (report) => database.onLateStartupCleanupFailure(report),
      },
    });
    return {
      status: 'ready',
      viewer: workspace,
      acquireDroppedSource: async (file) => host.registerSource(file),
    };
  } catch {
    return { status: 'unsupported' };
  }
}

/** Releases the page-scoped Worker and in-memory workspace when navigation completes. */
export function disposeWorkspaceWhenPageHides(
  workspace: Pick<CsvWorkspaceOwner, 'dispose'>,
  page: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window,
  reload: () => void = () => window.location.reload(),
): () => void {
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    void workspace.dispose().catch(() => {
      // The workspace already reports sanitized disposal failures.
    });
  };
  const handlePageShow = (event: Event) => {
    if (!isPersistedPageTransition(event)) return;
    page.removeEventListener('pageshow', handlePageShow);
    reload();
  };
  const handlePageHide = (event: Event) => {
    page.removeEventListener('pagehide', handlePageHide);
    dispose();
    if (!isPersistedPageTransition(event)) {
      page.removeEventListener('pageshow', handlePageShow);
    }
  };
  page.addEventListener('pagehide', handlePageHide);
  page.addEventListener('pageshow', handlePageShow);
  return () => {
    page.removeEventListener('pagehide', handlePageHide);
    page.removeEventListener('pageshow', handlePageShow);
    dispose();
  };
}

function isPersistedPageTransition(event: Event): boolean {
  return 'persisted' in event && event.persisted === true;
}
