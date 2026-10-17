import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  type BrowserWindowConstructorOptions,
  type MessageBoxOptions,
  type WebContents,
} from 'electron';
import path from 'node:path';
import { ConfigProvider, Deferred, Effect, Logger, Option, Queue, Schema } from 'effect';
import { toError } from '@csv-viewer/workspace/errors';
import { authorizeDroppedPathChannel } from '../dropped-path-channel';
import {
  DesktopLifecycle,
  devServerUrlConfig,
  runDesktopProgram,
  observeDocumentOpen,
  recoverTypedFailure,
  WindowWorkspace,
  type CloseOutcome,
  type DesktopProgramEvent,
} from './desktop-lifecycle';
import { buildApplicationMenuTemplate } from './application-menu';
import { serveWorkspacePort } from './csv-viewer-port';
import { createCsvViewer } from '@csv-viewer/workspace/csv-workspace';
import { DuckDbWorkspaceDatabase } from './duckdb-database';
import { openDesktopWorkspace } from './desktop-workspace-host';
import {
  DroppedPathAuthorization,
  openAuthorizedDroppedPath,
  recordDroppedPathFromPreload,
} from './dropped-path-authorization';
import {
  supportedCsvFileExtensions,
  type WorkspaceCloseImpact,
} from '@csv-viewer/workspace/csv-viewer';

const electronRoot = __dirname;
const workspaceHost = openDesktopWorkspace(
  {
    chooseSource: async () => {
      const result = await dialog.showOpenDialog({
        title: 'Open CSV',
        properties: ['openFile'],
        filters: [
          { name: 'CSV files', extensions: [...supportedCsvFileExtensions] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    },
    chooseExportDestination: async (defaultPath) => {
      const ownerWindow = focusedWindow();
      const saveOptions = {
        title: 'Export CSV',
        defaultPath,
        filters: [
          { name: 'CSV files', extensions: ['csv'] },
          { name: 'Text files', extensions: ['txt', 'tsv'] },
          { name: 'All files', extensions: ['*'] },
        ],
      };
      const result = ownerWindow
        ? await dialog.showSaveDialog(ownerWindow, saveOptions)
        : await dialog.showSaveDialog(saveOptions);
      return result.canceled ? null : (result.filePath ?? null);
    },
    showSourceConflict: async () => {
      await showMessageBox({
        type: 'warning',
        title: 'Choose a different export destination',
        message: 'Export CSV keeps the opened CSV Source unchanged.',
        detail: 'Choose a different destination for the exported CSV.',
        buttons: ['Choose destination'],
        defaultId: 0,
        noLink: true,
      });
    },
    confirmDiscardChanges,
  },
  // File name predates the Recent CSV Source vocabulary; kept so existing installs keep their list.
  path.join(app.getPath('userData'), 'recent-files.json'),
);
let documentContents: WebContents | undefined;
let acceptingDocuments = true;
// SAFETY: `shared` starts empty and later holds the in-flight close effect. Null is that empty slot.
const quit = {
  allowed: false,
  requested: false,
  shared: null as Effect.Effect<CloseOutcome, Error> | null,
};
const pendingEvents: DesktopProgramEvent[] = [];
let offerEvent: ((event: DesktopProgramEvent) => void) | null = null;

/** Buffers events until the program owns the queue, so quit during module startup is not lost. */
function pushEvent(event: DesktopProgramEvent): void {
  if (event._tag === 'quit') {
    if (quit.allowed || quit.requested) return;
    quit.requested = true;
    quit.shared = documentWorkspace.inFlightClose();
  }
  if (offerEvent) offerEvent(event);
  else pendingEvents.push(event);
}

function connectEvents(events: Queue.Queue<DesktopProgramEvent>): void {
  offerEvent = (event) => {
    Queue.offerUnsafe(events, event);
  };
  for (const event of pendingEvents) Queue.offerUnsafe(events, event);
  pendingEvents.length = 0;
}

function processEnv() {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
const droppedPaths = new DroppedPathAuthorization();

ipcMain.on(authorizeDroppedPathChannel, (event, payload) => {
  event.returnValue = Schema.is(Schema.String)(payload)
    && recordDroppedPathFromPreload(droppedPaths, event.sender.id, documentContents?.id, payload);
});

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

async function showMessageBox(options: MessageBoxOptions): Promise<number> {
  const ownerWindow = focusedWindow();
  const result = ownerWindow ? await dialog.showMessageBox(ownerWindow, options) : await dialog.showMessageBox(options);
  return result.response;
}

function registerContentSecurityPolicy(isDevelopment: boolean) {
  const csp = [
    "default-src 'self'",
    `script-src 'self'${isDevelopment ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self'${isDevelopment ? ' http://127.0.0.1:5173 ws://127.0.0.1:5173' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

const createWindow = (devServerUrl: Option.Option<string>) => Effect.gen(function* () {
  const windowOptions: BrowserWindowConstructorOptions = {
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    title: 'CSV Viewer',
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(electronRoot, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };

  const mainWindow = new BrowserWindow(windowOptions);
  const { webContents } = mainWindow;
  droppedPaths.clear();
  documentContents = webContents;
  webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument || quit.allowed || !acceptingDocuments) return;
    droppedPaths.clear();
    const opening = documentWorkspace.replace();
    observeDocumentOpen(opening, () => {
      console.error('CSV Viewer could not open its workspace.');
      app.exit(1);
    });
  });
  webContents.on('render-process-gone', () => {
    if (quit.allowed) return;
    pushEvent({ _tag: 'renderer-gone' });
  });
  mainWindow.on('close', (event) => {
    if (!documentWorkspace.isOpen) return;
    event.preventDefault();
    void Effect.runPromise(withReleaseLog(documentWorkspace.close())).then((outcome) => {
      if (outcome === 'disposed' && !mainWindow.isDestroyed()) mainWindow.close();
      else if (outcome === 'failed') reportCloseFailure();
      else if (outcome === 'forced') app.exit(1);
    }, reportCloseFailure);
  });

  if (Option.isSome(devServerUrl)) {
    const url = devServerUrl.value;
    yield* Effect.tryPromise({ try: () => mainWindow.loadURL(url), catch: toError });
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  yield* Effect.tryPromise({ try: () => mainWindow.loadFile(path.join(electronRoot, '../dist-renderer/index.html')), catch: toError });
});

function createApplicationMenu(isDevelopment: boolean) {
  const template = buildApplicationMenuTemplate({
    platform: process.platform,
    appName: app.name,
    isDevelopment,
    onIntent: (intent) => {
      const current = documentWorkspace.get();
      if (!current) return;
      void current.then((document) => document.workspace.publishIntent(intent));
    },
    onAbout: () => {
      void showMessageBox({
        type: 'info',
        title: 'About CSV Viewer',
        message: 'CSV Viewer',
        detail: 'A desktop viewer for opening, inspecting, filtering, and sorting CSV-style files.',
      });
    },
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function confirmDiscardChanges(sourceName: string): Promise<boolean> {
  const response = await showMessageBox({
    type: 'warning',
    title: 'Unexported Changes',
    message: `Discard Unexported Changes to ${sourceName}?`,
    detail: 'Changes not represented by an Export CSV will be lost.',
    buttons: ['Discard', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });

  return response === 0;
}

async function confirmWorkspaceClose(impact: WorkspaceCloseImpact): Promise<boolean> {
  const details: string[] = [];
  if (impact.workingCsvsWithUnexportedChanges.length > 0) {
    details.push(
      `Unexported Changes will be lost:\n${impact.workingCsvsWithUnexportedChanges.map((csv) => csv.sourceName).join('\n')}`,
    );
  }
  if (impact.dependentComparisons.length > 0) {
    details.push(
      `Open comparisons will close:\n${impact.dependentComparisons
        .map((comparison) => `${comparison.baselineName} ↔ ${comparison.candidateName}`)
        .join('\n')}`,
    );
  }
  const response = await showMessageBox({
    type: 'warning',
    title: 'Close CSV Viewer',
    message: 'Close CSV Viewer?',
    detail: details.join('\n\n'),
    buttons: ['Close', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
}

/** Event failures keep the window open and never print source identities or driver causes. */
function reportCloseFailure() {
  console.error('CSV Viewer could not confirm closing. Try closing again.');
}

const exitProcess = (code: number) => { app.exit(code); };

function withReleaseLog<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return effect.pipe(Effect.provide(Logger.layer([Logger.consoleLogFmt])));
}

/** The one window's document owns the workspace; closing the window or loading a new document ends it. */
const documentWorkspace = new WindowWorkspace(async (signal) => {
  const contents = documentContents;
  if (!contents) throw new Error('CSV Viewer has no document to serve.');
  const stopped = Effect.runSync(Deferred.make<void>());
  const workspace = await createCsvViewer(DuckDbWorkspaceDatabase.open(), workspaceHost, {
    startup: { signal, stopped },
    acquireDroppedPath: (filePath) => openAuthorizedDroppedPath(
      droppedPaths,
      (authorizedPath) => workspaceHost.acquireDroppedSource(authorizedPath),
      filePath,
    ),
  });
  const lifecycle = new DesktopLifecycle(workspace, (impact) => Effect.tryPromise({
    try: () => confirmWorkspaceClose(impact), catch: toError,
  }), exitProcess);
  const detach = await serveWorkspacePort(contents, workspace);
  return { workspace, lifecycle, detach };
}, exitProcess);

function finishQuit(outcome: CloseOutcome): void {
  quit.requested = false;
  switch (outcome) {
    case 'cancelled':
      acceptingDocuments = true;
      return;
    case 'disposed':
      quit.allowed = true;
      app.quit();
      return;
    case 'failed':
    case 'forced':
      app.exit(1);
      return;
    default: {
      const unexpected: never = outcome;
      throw unexpected;
    }
  }
}

/** Registered before the program starts, so a quit during acquisition still reaches it. */
app.on('before-quit', (event) => {
  if (quit.allowed) return;
  event.preventDefault();
  pushEvent({ _tag: 'quit' });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') pushEvent({ _tag: 'quit' });
});

const program = Effect.gen(function* () {
  const events = yield* Queue.unbounded<DesktopProgramEvent>();
  yield* Effect.sync(() => { connectEvents(events); });
  const devServerUrl = yield* devServerUrlConfig.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: processEnv() }))),
  );
  const isDevelopment = Option.isSome(devServerUrl);
  yield* runDesktopProgram({
    events,
    prepareQuit: Effect.sync(() => { acceptingDocuments = false; }),
    startup: recoverTypedFailure(Effect.gen(function* () {
      yield* Effect.tryPromise({ try: () => app.whenReady(), catch: toError });
      registerContentSecurityPolicy(isDevelopment);
      createApplicationMenu(isDevelopment);
      app.on('activate', () => { pushEvent({ _tag: 'activate' }); });
      yield* createWindow(devServerUrl);
    }), () => {
      console.error('CSV Viewer failed to start.');
      app.exit(1);
    }),
    openWindow: Effect.gen(function* () {
      if (BrowserWindow.getAllWindows().length > 0) return;
      yield* recoverTypedFailure(createWindow(devServerUrl), () => {
        console.error('CSV Viewer could not open a window.');
      });
    }),
    close: Effect.gen(function* () {
      const shared = quit.shared;
      quit.shared = null;
      if (shared) return yield* shared;
      return yield* withReleaseLog(documentWorkspace.close());
    }),
    dropRenderer: withReleaseLog(documentWorkspace.drop()),
    onClose: (outcome) => Effect.sync(() => { finishQuit(outcome); }),
    onCloseFailure: Effect.sync(() => {
      quit.requested = false;
      acceptingDocuments = true;
      reportCloseFailure();
    }),
  });
});

Effect.runFork(program.pipe(Effect.catchCause(() => Effect.sync(() => {
  console.error('CSV Viewer failed to start.');
  app.exit(1);
}))));
