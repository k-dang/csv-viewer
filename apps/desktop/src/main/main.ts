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
import { Effect, Schema } from 'effect';
import { toError } from '@csv-viewer/workspace/errors';
import { authorizeDroppedPathChannel } from '../dropped-path-channel';
import { DesktopLifecycle, WindowWorkspace } from './desktop-lifecycle';
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
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
let documentContents: WebContents | undefined;
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

const createWindow = Effect.fnUntraced(function* () {
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
    if (!details.isMainFrame || details.isSameDocument || quit.allowed) return;
    droppedPaths.clear();
    documentWorkspace.replace().catch(() => {
      console.error('CSV Viewer could not open its workspace.');
      app.exit(1);
    });
  });
  mainWindow.on('close', (event) => {
    if (!documentWorkspace.isOpen) return;
    event.preventDefault();
    void documentWorkspace.close().then((outcome) => {
      if (outcome === 'disposed' && !mainWindow.isDestroyed()) mainWindow.close();
      else if (outcome === 'failed') reportCloseFailure();
      else if (outcome === 'forced') app.exit(1);
    }, reportCloseFailure);
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

/** The one window's document owns the workspace; closing the window or loading a new document ends it. */
const documentWorkspace = new WindowWorkspace(async () => {
  const contents = documentContents;
  if (!contents) throw new Error('CSV Viewer has no document to serve.');
  const workspace = await createCsvViewer(DuckDbWorkspaceDatabase.open(), workspaceHost, {
    acquireDroppedPath: (filePath) => openAuthorizedDroppedPath(
      droppedPaths,
      (authorizedPath) => workspaceHost.acquireDroppedSource(authorizedPath),
      filePath,
    ),
  });
  const lifecycle = new DesktopLifecycle(workspace, (impact) => Effect.tryPromise({
    try: () => confirmWorkspaceClose(impact), catch: toError,
  }), (code) => app.exit(code));
  const detach = await serveWorkspacePort(contents, workspace);
  return { workspace, lifecycle, detach };
});

/** Registered before startup, so a quit while the workspace opens still waits for it and disposes it. */
const quit = { allowed: false, requested: false };
app.on('before-quit', (event) => {
  if (quit.allowed) return;
  event.preventDefault();
  if (quit.requested) return;
  quit.requested = true;
  void documentWorkspace.close().then((outcome) => {
    quit.requested = false;
    if (outcome === 'disposed') {
      quit.allowed = true;
      app.quit();
    } else if (outcome === 'failed' || outcome === 'forced') {
      app.exit(1);
    }
  }, () => {
    quit.requested = false;
    reportCloseFailure();
  });
});

const startup = Effect.gen(function* () {
  yield* Effect.tryPromise({ try: () => app.whenReady(), catch: toError });
  registerContentSecurityPolicy();
  createApplicationMenu();
  yield* createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      Effect.runFork(createWindow().pipe(Effect.catchCause(() => Effect.sync(() => {
        console.error('CSV Viewer could not open a window.');
      }))));
    }
  });
});

Effect.runFork(startup.pipe(Effect.catchCause(() => Effect.sync(() => {
  console.error('CSV Viewer failed to start.');
  app.exit(1);
}))));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
