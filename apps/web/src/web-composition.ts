import { createCsvViewer, type CsvWorkspaceOwner } from '@csv-viewer/workspace/csv-workspace';
import type {
  ConfirmWorkspaceCloseOutcome,
  CsvCapacityExceeded,
  CsvSourceId,
  CsvViewerEvent,
  CsvViewerRequest,
  CsvViewerResult,
  WorkspaceCloseImpact,
} from '@csv-viewer/workspace/csv-viewer';
import { DuckDbWasmWorkspaceDatabase } from './duckdb-wasm-database';
import type { WebCsvCapacityLimits, WebCsvFilePicker } from './web-workspace-host';
import { WebWorkspaceHost } from './web-workspace-host';

export type WebCsvViewerStartup =
  | { status: 'ready'; viewer: CsvWorkspaceOwner; acquireDroppedSource: (file: File) => Promise<CsvSourceId | CsvCapacityExceeded> }
  | { status: 'unsupported' };

/** Acquires the pinned Worker, which proves its in-memory CSV path, before file selection is enabled. */
export async function startWebCsvViewer(
  database: DuckDbWasmWorkspaceDatabase,
  pickFile: WebCsvFilePicker,
  limits?: WebCsvCapacityLimits,
  signal?: AbortSignal,
): Promise<WebCsvViewerStartup> {
  const fatalError = Promise.withResolvers<never>();
  const stopWatchingStartup = database.onFatalError(fatalError.reject);
  const cancel = () => database.cancelStartup();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) cancel();
    const host = new WebWorkspaceHost(database, pickFile, limits);
    const workspace = await Promise.race([createCsvViewer(() => database.open(), host), fatalError.promise]);
    stopWatchingStartup();
    return {
      status: 'ready',
      viewer: new WebCsvViewerSession(workspace, database),
      acquireDroppedSource: async (file) => host.registerSource(file),
    };
  } catch (error) {
    stopWatchingStartup();
    if (!signal?.aborted) console.error('CSV Viewer Web startup check failed.', error);
    // A failed build already released the engine. After a fatal stop, wait for its termination.
    await database.closeEngine().catch((failure) => console.error('CSV Viewer Web cleanup failed.', failure));
    return { status: 'unsupported' };
  } finally {
    signal?.removeEventListener('abort', cancel);
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

/** Makes a Worker crash terminal for the page instead of rebuilding part of the workspace. */
class WebCsvViewerSession implements CsvWorkspaceOwner {
  private readonly listeners = new Set<(event: CsvViewerEvent) => void>();
  private readonly stopWorkspaceEvents: () => void;
  private readonly stopFatalErrors: () => void;
  private fatalEvent: Extract<CsvViewerEvent, { type: 'fatal-error' }> | null = null;

  constructor(
    private readonly workspace: CsvWorkspaceOwner,
    private readonly database: DuckDbWasmWorkspaceDatabase,
  ) {
    this.stopWorkspaceEvents = workspace.onEvent((event) => {
      if (!this.fatalEvent) this.emit(event);
    });
    this.stopFatalErrors = database.onFatalError(() => this.fail());
  }

  get capabilities() {
    return this.workspace.capabilities;
  }

  call<Request extends CsvViewerRequest>(request: Request): Promise<CsvViewerResult<Request>>;
  call(request: CsvViewerRequest): Promise<CsvViewerResult<CsvViewerRequest>> {
    return this.receive(request);
  }

  // The wrapped workspace decodes the payload.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  receive(payload: unknown): Promise<CsvViewerResult<CsvViewerRequest>> {
    if (this.fatalEvent) return Promise.reject(workspaceStoppedError());
    return this.workspace.receive(payload);
  }

  onEvent(listener: (event: CsvViewerEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.fatalEvent) listener(this.fatalEvent);
    return () => this.listeners.delete(listener);
  }

  confirmClose(confirmedImpact?: WorkspaceCloseImpact): Promise<ConfirmWorkspaceCloseOutcome> {
    if (this.fatalEvent) return Promise.reject(workspaceStoppedError());
    return this.workspace.confirmClose(confirmedImpact);
  }

  async dispose(): Promise<void> {
    this.stopWorkspaceEvents();
    this.stopFatalErrors();
    this.listeners.clear();
    if (!this.fatalEvent) {
      await this.workspace.dispose();
      return;
    }
    await this.database.closeEngine().catch(() => console.error('CSV Viewer Web cleanup failed.'));
  }

  private fail(): void {
    if (this.fatalEvent) return;
    this.fatalEvent = {
      type: 'fatal-error',
      message: 'The local data engine stopped unexpectedly.',
    };
    this.stopWorkspaceEvents();
    this.emit(this.fatalEvent);
  }

  private emit(event: CsvViewerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function workspaceStoppedError(): Error {
  return new Error('The data engine has stopped. Reload CSV Viewer to start a new workspace.');
}
