import { connectInProcessSession } from '@csv-viewer/workspace/csv-viewer-client';
import { createCsvViewer, type CsvViewerSession, type CsvWorkspaceServer } from '@csv-viewer/workspace/csv-workspace';
import type {
  CsvCapacityExceeded,
  CsvSourceId,
} from '@csv-viewer/workspace/csv-viewer';
import { DataEngineError, stoppedEngineMessage } from '@csv-viewer/workspace/database';
import { isExpectedWorkspaceError, WorkspaceRequestError } from '@csv-viewer/workspace/errors';
import type { WorkspaceDiagnostics } from '@csv-viewer/workspace/workspace-diagnostics';
import { buildWorkspaceHost } from '@csv-viewer/workspace/workspace-host';
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';
import { DuckDbWasmWorkspaceDatabase } from './duckdb-wasm-database';
import type { WebCsvCapacityLimits, WebCsvFilePicker } from './web-workspace-host';
import { WebWorkspaceHost, webWorkspaceHostLayer } from './web-workspace-host';

export type WebCsvViewerStartup =
  | { status: 'ready'; viewer: CsvViewerSession; acquireDroppedSource: (file: File) => Promise<CsvSourceId | CsvCapacityExceeded> }
  | { status: 'unsupported' }
  | { status: 'failed' };

/** Matches the desktop workspace release bound. A dispose that is still running does not hide the failure. */
const startupReleaseBound = '60 seconds';

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
  let workspace: CsvWorkspaceServer | undefined;
  try {
    const host = new WebWorkspaceHost(database, pickFile, limits);
    workspace = await createCsvViewer(database.open(), buildWorkspaceHost(webWorkspaceHostLayer(host)), {
      diagnostics,
      startup: { signal, stopped: database.stopped },
    });
    return {
      status: 'ready',
      viewer: await connectInProcessSession(workspace),
      acquireDroppedSource: async (file) => host.registerSource(file),
    };
  } catch (cause) {
    return await Effect.runPromise(settleFailedWebStartup(workspace, cause, signal));
  }
}

/**
 * Releases a workspace acquired before startup failed, then classifies the failure.
 * Disposal is detached and the wait is bounded at 60 seconds, so a dispose that does not
 * settle still logs a defect and rejects into the failed startup screen.
 */
export function settleFailedWebStartup(
  workspace: Pick<CsvWorkspaceServer, 'dispose'> | undefined,
  cause: unknown,
  signal: AbortSignal | undefined,
): Effect.Effect<WebCsvViewerStartup, unknown> {
  return Effect.gen(function* () {
    if (workspace) yield* releaseFailedStartup(workspace);
    if (isStoppedEngine(cause)) return { status: 'failed' as const };
    // Cancellation and an engine that cannot start are unsupported. A defect stays a defect.
    if (signal?.aborted || cause instanceof DataEngineError || isExpectedWorkspaceError(cause)) {
      return { status: 'unsupported' as const };
    }
    yield* Effect.logError('web.startup-defect').pipe(Effect.annotateLogs({ outcome: 'failed' }));
    return yield* Effect.fail(cause);
  });
}

function isStoppedEngine(cause: unknown): cause is WorkspaceRequestError {
  return cause instanceof WorkspaceRequestError && cause.message === stoppedEngineMessage;
}

function releaseFailedStartup(workspace: Pick<CsvWorkspaceServer, 'dispose'>): Effect.Effect<void> {
  return Effect.gen(function* () {
    const settled = yield* Deferred.make<void, Error>();
    yield* Effect.forkDetach(Effect.uninterruptible(Effect.gen(function* () {
      // Disposal failures are already sanitized by the workspace. They must not replace the startup cause.
      yield* Effect.exit(Effect.tryPromise({ try: () => workspace.dispose(), catch: () => undefined }));
      yield* Deferred.succeed(settled, undefined);
    })));
    const waited = yield* Effect.exit(Deferred.await(settled).pipe(Effect.timeout(startupReleaseBound)));
    if (Exit.isSuccess(waited)) return;
    if (isTimeoutCause(waited.cause)) return;
  });
}

function isTimeoutCause(cause: Cause.Cause<unknown>): boolean {
  return cause.reasons.some((reason) => reason._tag === 'Fail' && Cause.isTimeoutError(reason.error));
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
