import { connectInProcessSession } from '@csv-viewer/workspace/csv-viewer-client';
import { createCsvViewer, type CsvViewerSession } from '@csv-viewer/workspace/csv-workspace';
import type {
  CsvCapacityExceeded,
  CsvSourceId,
} from '@csv-viewer/workspace/csv-viewer';
import { DataEngineError } from '@csv-viewer/workspace/database';
import { isExpectedWorkspaceError } from '@csv-viewer/workspace/errors';
import type { WorkspaceDiagnostics } from '@csv-viewer/workspace/workspace-diagnostics';
import { buildWorkspaceHost } from '@csv-viewer/workspace/workspace-host';
import { Effect, Fiber } from 'effect';
import { DuckDbWasmWorkspaceDatabase } from './duckdb-wasm-database';
import type { WebCsvCapacityLimits, WebCsvFilePicker } from './web-workspace-host';
import { WebWorkspaceHost, webWorkspaceHostLayer } from './web-workspace-host';

export type WebCsvViewerStartup =
  | { status: 'ready'; viewer: CsvViewerSession; acquireDroppedSource: (file: File) => Promise<CsvSourceId | CsvCapacityExceeded> }
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
    const workspace = await createCsvViewer(database.open(), buildWorkspaceHost(webWorkspaceHostLayer(host)), {
      diagnostics,
      startup: { signal, stopped: database.stopped },
    });
    return {
      status: 'ready',
      viewer: await connectInProcessSession(workspace),
      acquireDroppedSource: async (file) => host.registerSource(file),
    };
  } catch (cause) {
    // Cancellation and an engine that cannot start are unsupported. A defect stays a defect.
    if (signal?.aborted || cause instanceof DataEngineError || isExpectedWorkspaceError(cause)) {
      return { status: 'unsupported' };
    }
    await Effect.runPromise(Effect.logError('web.startup-defect').pipe(
      Effect.annotateLogs({ outcome: 'failed' }),
    ));
    throw cause;
  }
}

/** Releases the page-scoped Worker and in-memory workspace when navigation completes. */
export function disposeWorkspaceWhenPageHides(
  workspace: Pick<CsvViewerSession, 'dispose'>,
  page: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window,
  reload: () => void = () => window.location.reload(),
): () => void {
  const fiber = Effect.runFork(Effect.scoped(Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      try {
        await workspace.dispose();
      } catch {
        // The workspace already reports sanitized disposal failures.
      }
    }));
    yield* Effect.never;
  })));
  let closed = false;
  const closeScope = () => {
    if (closed) return;
    closed = true;
    void Effect.runPromise(Fiber.interrupt(fiber));
  };
  const handlePageShow = (event: Event) => {
    if (!isPersistedPageTransition(event)) return;
    page.removeEventListener('pageshow', handlePageShow);
    reload();
  };
  const handlePageHide = (event: Event) => {
    page.removeEventListener('pagehide', handlePageHide);
    closeScope();
    if (!isPersistedPageTransition(event)) {
      page.removeEventListener('pageshow', handlePageShow);
    }
  };
  page.addEventListener('pagehide', handlePageHide);
  page.addEventListener('pageshow', handlePageShow);
  return () => {
    page.removeEventListener('pagehide', handlePageHide);
    page.removeEventListener('pageshow', handlePageShow);
    closeScope();
  };
}

function isPersistedPageTransition(event: Event): boolean {
  return 'persisted' in event && event.persisted === true;
}
