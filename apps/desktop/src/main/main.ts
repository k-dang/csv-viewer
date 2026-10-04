import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  type BrowserWindowConstructorOptions,
  type MessageBoxOptions,
} from 'electron';
import path from 'node:path';
import { Effect } from 'effect';
import { toError } from '@csv-viewer/workspace/errors';
import { DesktopLifecycle } from './desktop-lifecycle';
import { buildApplicationMenuTemplate } from './application-menu';
import { registerCsvViewerRequestHandler, registerDroppedSourceHandler } from './csv-viewer-ipc';
import { createCsvViewer } from '@csv-viewer/workspace/csv-workspace';
import { DuckDbWorkspaceDatabase } from './duckdb-database';
import { DesktopWorkspaceHost } from './desktop-workspace-host';
import { ipcChannels } from '../ipc-channels';
import {
  supportedCsvFileExtensions,
  type CsvViewerEvent,
  type WorkspaceCloseImpact,
} from '@csv-viewer/workspace/csv-viewer';

const electronRoot = __dirname;
const workspaceHost = new DesktopWorkspaceHost(
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
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

async function showMessageBox(options: MessageBoxOptions): Promise<number> {
  const ownerWindow = focusedWindow();
  const result = ownerWindow ? await dialog.showMessageBox(ownerWindow, options) : await dialog.showMessageBox(options);
  return result.response;
}

function registerContentSecurityPolicy() {
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

const createWindow = Effect.fnUntraced(function* (lifecycle: DesktopLifecycle) {
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
  let closeAllowed = false;

  mainWindow.on('close', (event) => {
    if (closeAllowed || lifecycle.isDisposed) return;
    event.preventDefault();
    Effect.runFork(lifecycle.requestWindowClose().pipe(
      Effect.tap((allowed) => Effect.sync(() => {
        if (!allowed) return;
        closeAllowed = true;
        if (!mainWindow.isDestroyed()) mainWindow.close();
      })),
      Effect.catchCause(() => reportCloseFailure),
    ));
  });

  if (isDevelopment) {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (!devServerUrl) throw new Error('VITE_DEV_SERVER_URL is required in development.');
    yield* Effect.tryPromise({ try: () => mainWindow.loadURL(devServerUrl), catch: toError });
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  yield* Effect.tryPromise({ try: () => mainWindow.loadFile(path.join(electronRoot, '../dist-renderer/index.html')), catch: toError });
});

function createApplicationMenu() {
  const template = buildApplicationMenuTemplate({
    platform: process.platform,
    appName: app.name,
    isDevelopment,
    onIntent: (intent) => {
      // A menu command acts on the window the user is looking at, not on every open window.
      focusedWindow()?.webContents.send(ipcChannels.event, { type: 'intent', intent } satisfies CsvViewerEvent);
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

function sendEvent(event: CsvViewerEvent) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    window.webContents.send(ipcChannels.event, event);
  }
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
const reportCloseFailure = Effect.sync(() => {
  console.error('CSV Viewer could not confirm closing. Try closing again.');
});

const startup = Effect.gen(function* () {
  yield* Effect.tryPromise({ try: () => app.whenReady(), catch: toError });
  registerContentSecurityPolicy();
  createApplicationMenu();
  const workspace = yield* Effect.tryPromise({
    try: () => createCsvViewer(DuckDbWorkspaceDatabase.open(), workspaceHost), catch: toError,
  });
  const lifecycle = new DesktopLifecycle(workspace, (impact) => Effect.tryPromise({
    try: () => confirmWorkspaceClose(impact), catch: toError,
  }));
  yield* Effect.gen(function* () {
    registerCsvViewerRequestHandler(ipcMain, workspace);
    registerDroppedSourceHandler(ipcMain, (filePath) => workspaceHost.acquireDroppedSource(filePath));
    workspace.onEvent(sendEvent);
    // Registered only once the workspace exists: quitting before then has nothing to dispose.
    app.on('before-quit', (event) => {
      if (lifecycle.isDisposed) return;
      event.preventDefault();
      Effect.runFork(lifecycle.requestQuit().pipe(
        Effect.tap((result) => Effect.sync(() => {
          if (result === 'disposed') app.quit();
          else if (result === 'failed') app.exit(1);
        })),
        Effect.catchCause(() => reportCloseFailure),
      ));
    });
    yield* createWindow(lifecycle);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        Effect.runFork(createWindow(lifecycle).pipe(Effect.catchCause(() => Effect.sync(() => {
          console.error('CSV Viewer could not open a window.');
        }))));
      }
    });
  }).pipe(Effect.onError(() => Effect.promise(() => workspace.dispose()).pipe(Effect.ignoreCause)));
});

Effect.runFork(startup.pipe(Effect.catchCause(() => Effect.sync(() => {
  console.error('CSV Viewer failed to start.');
  app.exit(1);
}))));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
