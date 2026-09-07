import { quoteLiteral } from '@csv-viewer/workspace/csv-query';
import { createCsvViewer, type CsvWorkspaceOwner } from '@csv-viewer/workspace/csv-workspace';
import type {
  ConfirmWorkspaceCloseOutcome,
  CsvViewerEvent,
  CsvViewerRequest,
  CsvViewerResult,
  WorkspaceCloseImpact,
} from '@csv-viewer/workspace/csv-viewer';
import { DuckDbWasmWorkspaceDatabase } from './duckdb-wasm-database';
import type { WebCsvFilePicker } from './web-workspace-host';
import { WebWorkspaceHost } from './web-workspace-host';

export type WebCsvViewerStartup =
  | { status: 'ready'; viewer: CsvWorkspaceOwner }
  | { status: 'unsupported' };

/** Starts the pinned Worker and proves its in-memory CSV path before file selection is enabled. */
export async function startWebCsvViewer(
  database: DuckDbWasmWorkspaceDatabase,
  pickFile: WebCsvFilePicker,
): Promise<WebCsvViewerStartup> {
  let rejectOnFatalError: ((error: Error) => void) | undefined;
  const fatalError = new Promise<never>((_resolve, reject) => {
    rejectOnFatalError = reject;
  });
  const stopWatchingStartup = database.onFatalError((error) => rejectOnFatalError?.(error));
  try {
    await Promise.race([verifyRequiredWasmFeatures(database), fatalError]);
    stopWatchingStartup();
    const workspace = createCsvViewer(new WebWorkspaceHost(database, pickFile), database);
    return {
      status: 'ready',
      viewer: new WebCsvViewerSession(workspace, database),
    };
  } catch (error) {
    stopWatchingStartup();
    console.error('CSV Viewer Web startup check failed.', error);
    const failures = await database.close();
    failures.forEach((failure) => console.error('CSV Viewer Web cleanup failed.', failure));
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
    void workspace.dispose().catch((error) => {
      console.error('CSV Viewer Web cleanup failed.', error);
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

  call<Request extends CsvViewerRequest>(request: Request): Promise<CsvViewerResult<Request>> {
    if (this.fatalEvent) return Promise.reject(workspaceStoppedError());
    return this.workspace.call(request);
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
    const failures = await this.database.close();
    failures.forEach((failure) => console.error('CSV Viewer Web cleanup failed.', failure));
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

async function verifyRequiredWasmFeatures(database: DuckDbWasmWorkspaceDatabase): Promise<void> {
  // Encoded per call: registering hands the buffer to the Worker, which may detach it.
  const probe = new TextEncoder().encode('ready\ntrue\n');
  const rows = await database.withRegisteredFile('startup-check.csv', probe, (reference) =>
    database.readObjects(
      `SELECT ready FROM read_csv_auto(${quoteLiteral(reference)}, all_varchar = true, header = true)`,
    ),
  );
  if (rows.length !== 1 || rows[0]?.ready !== 'true') {
    throw new Error('The browser could not run the required in-memory CSV query.');
  }
}
