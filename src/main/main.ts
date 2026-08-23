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
import { buildApplicationMenuTemplate } from './application-menu';
import { CsvWorkspace, type WorkspaceCloseImpact } from '../workspace/csv-workspace';
import { DesktopWorkspaceHost } from './desktop-workspace-host';
import { ipcChannels } from '../shared/ipc-channels';
import {
  supportedCsvFileExtensions,
  type BeginComparisonRequest,
  type CancelComparisonRequest,
  type CloseWorkingCsvRequest,
  type ComparisonEvent,
  type ComparisonWindowRequest,
  type CsvCellEditRequest,
  type CsvColumnValueCountsRequest,
  type CsvDeleteRowsRequest,
  type CsvDialectOptions,
  type CsvEditStateRequest,
  type CsvInsertRowRequest,
  type CsvRowWindowRequest,
  type CsvSourceId,
  type CsvViewerIntent,
  type CsvExportRequest,
  type HealthStatus,
  type OpenComparisonRequest,
  type ReopenCsvResult,
} from '../shared/csv-viewer-contract';

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
  },
  // File name predates the Recent CSV Source vocabulary; kept so existing installs keep their list.
  path.join(app.getPath('userData'), 'recent-files.json'),
);
const workspace = new CsvWorkspace(workspaceHost);
let workspaceCloseAuthorizedImpact: WorkspaceCloseImpact | undefined;
let workspaceCloseConfirmation: Promise<WorkspaceCloseImpact | null> | null = null;

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

async function showMessageBox(options: MessageBoxOptions): Promise<number> {
  const ownerWindow = focusedWindow();
  const result = ownerWindow
    ? await dialog.showMessageBox(ownerWindow, options)
    : await dialog.showMessageBox(options);
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

function createWindow() {
  const windowOptions: BrowserWindowConstructorOptions = {
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    title: 'CSV Viewer',
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(electronRoot, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };

  const mainWindow = new BrowserWindow(windowOptions);
  let closeAllowed = false;

  mainWindow.on('close', (event) => {
    if (closeAllowed) return;
    event.preventDefault();
    void (async () => {
      const initial = await workspace.confirmWindowClose();
      if (initial.status === 'ready') {
        closeAllowed = true;
        if (!mainWindow.isDestroyed()) mainWindow.close();
        return;
      }
      const confirmedImpact = await confirmWorkspaceCloseOnce(initial.impact);
      if (confirmedImpact) {
        workspaceCloseAuthorizedImpact = confirmedImpact;
        closeAllowed = true;
        if (!mainWindow.isDestroyed()) mainWindow.close();
      }
    })();
  });

  if (isDevelopment) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  void mainWindow.loadFile(path.join(electronRoot, '../../dist-renderer/index.html'));
}

function createApplicationMenu() {
  const template = buildApplicationMenuTemplate({
    platform: process.platform,
    appName: app.name,
    isDevelopment,
    onIntent: sendIntent,
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

function sendIntent(intent: CsvViewerIntent) {
  focusedWindow()?.webContents.send(ipcChannels.intent, intent);
}

function registerIpcHandlers() {
  ipcMain.handle(ipcChannels.healthCheck, (): HealthStatus => {
    return {
      ok: true,
      process: 'main',
      timestamp: new Date().toISOString(),
    };
  });

  ipcMain.handle(ipcChannels.openCsv, (_event, options?: CsvDialectOptions) =>
    workspace.openCsv(options),
  );

  ipcMain.handle(
    ipcChannels.openRecentCsv,
    (_event, sourceId: CsvSourceId, options?: CsvDialectOptions) =>
      workspace.openRecentCsv(sourceId, options),
  );

  ipcMain.handle(
    ipcChannels.reopenCsv,
    async (_event, workingCsvId: string, options?: CsvDialectOptions): Promise<ReopenCsvResult> => {
      const existing = await workspace.getWorkingCsv(workingCsvId);
      if (!existing) return { status: 'working-csv-not-found' };

      if (existing.editState.hasUnexportedChanges) {
        const canContinue = await confirmDiscardChanges(existing.file.name);
        if (!canContinue) return { status: 'cancelled' };
      }

      const replacement = await workspace.reopenCsv(workingCsvId, options);
      if (replacement.status === 'working-csv-not-found') return { status: 'working-csv-not-found' };
      if (replacement.status === 'failed') {
        return { status: 'failed', message: replacement.failure.message };
      }
      return { status: 'opened', workingCsv: replacement.workingCsv };
    },
  );

  ipcMain.handle(ipcChannels.closeCsv, (_event, request: CloseWorkingCsvRequest) =>
    workspace.closeCsv(request),
  );

  ipcMain.handle(ipcChannels.getComparisonCandidates, (_event, baselineId: string) =>
    workspace.getComparisonCandidates(baselineId),
  );

  ipcMain.handle(ipcChannels.openComparison, (_event, request: OpenComparisonRequest) =>
    workspace.openComparison(request),
  );

  ipcMain.handle(ipcChannels.getComparisonState, (_event, comparisonId: string) =>
    workspace.getComparisonState(comparisonId),
  );

  ipcMain.handle(ipcChannels.beginComparison, (_event, request: BeginComparisonRequest) =>
    workspace.beginComparison(request),
  );

  ipcMain.handle(ipcChannels.cancelComparison, (_event, request: CancelComparisonRequest) =>
    workspace.cancelComparison(request),
  );

  ipcMain.handle(ipcChannels.getComparisonWindow, (_event, request: ComparisonWindowRequest) =>
    workspace.getComparisonWindow(request),
  );

  ipcMain.handle(ipcChannels.swapComparison, (_event, comparisonId: string) =>
    workspace.swapComparison(comparisonId),
  );

  ipcMain.handle(ipcChannels.closeComparison, (_event, comparisonId: string) =>
    workspace.closeComparison(comparisonId),
  );

  ipcMain.handle(ipcChannels.getRecentCsvSources, () => workspace.getRecentCsvSources());

  ipcMain.handle(ipcChannels.getCsvRows, (_event, request: CsvRowWindowRequest) =>
    workspace.getCsvRows(request),
  );

  ipcMain.handle(
    ipcChannels.getCsvColumnValueCounts,
    (_event, request: CsvColumnValueCountsRequest) => workspace.getCsvColumnValueCounts(request),
  );

  ipcMain.handle(ipcChannels.editCsvCell, (_event, request: CsvCellEditRequest) =>
    workspace.editCsvCell(request),
  );

  ipcMain.handle(ipcChannels.deleteCsvRows, (_event, request: CsvDeleteRowsRequest) =>
    workspace.deleteCsvRows(request),
  );

  ipcMain.handle(ipcChannels.insertCsvRow, (_event, request: CsvInsertRowRequest) =>
    workspace.insertCsvRow(request),
  );

  ipcMain.handle(ipcChannels.getCsvEditState, (_event, request: CsvEditStateRequest) =>
    workspace.getCsvEditState(request),
  );

  ipcMain.handle(ipcChannels.exportCsv, (_event, request: CsvExportRequest) =>
    workspace.exportCsv(request),
  );

  ipcMain.handle(ipcChannels.undoCsvEdit, (_event, request: CsvEditStateRequest) =>
    workspace.undoCsvEdit(request),
  );

  ipcMain.handle(ipcChannels.redoCsvEdit, (_event, request: CsvEditStateRequest) =>
    workspace.redoCsvEdit(request),
  );
}

async function confirmDiscardChanges(fileName: string): Promise<boolean> {
  const response = await showMessageBox({
    type: 'warning',
    title: 'Unexported Changes',
    message: `Discard Unexported Changes to ${fileName}?`,
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
      `Unexported Changes will be lost:\n${impact.workingCsvsWithUnexportedChanges.map((csv) => csv.fileName).join('\n')}`,
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

async function confirmCurrentWorkspaceImpact(
  initialImpact: WorkspaceCloseImpact,
): Promise<WorkspaceCloseImpact | null> {
  let impact = initialImpact;
  while (await confirmWorkspaceClose(impact)) {
    const rechecked = await workspace.confirmWindowClose(impact);
    if (rechecked.status === 'ready') return impact;
    impact = rechecked.impact;
  }
  return null;
}

function confirmWorkspaceCloseOnce(
  impact: WorkspaceCloseImpact,
): Promise<WorkspaceCloseImpact | null> {
  if (!workspaceCloseConfirmation) {
    workspaceCloseConfirmation = confirmCurrentWorkspaceImpact(impact).finally(() => {
      workspaceCloseConfirmation = null;
    });
  }
  return workspaceCloseConfirmation;
}

app.whenReady().then(() => {
  registerContentSecurityPolicy();
  createApplicationMenu();
  registerIpcHandlers();
  workspace.onComparisonEvent((event: ComparisonEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      window.webContents.send(ipcChannels.comparisonStateChanged, event);
    }
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let workspaceDisposed = false;
let workspaceDisposalStarted = false;
const workspaceDisposalAttempts = 2;
const workspaceDisposalTimeoutMs = 10_000;

app.on('before-quit', (event) => {
  if (workspaceDisposed) return;
  event.preventDefault();
  if (workspaceDisposalStarted) return;
  void (async () => {
    const impact = await workspace.confirmWindowClose(workspaceCloseAuthorizedImpact);
    if (impact.status === 'ready') {
      if (workspaceDisposalStarted || workspaceDisposed) return;
      workspaceDisposalStarted = true;
      await disposeWorkspaceBeforeQuit();
      return;
    }
    const confirmedImpact = await confirmWorkspaceCloseOnce(impact.impact);
    if (!confirmedImpact || workspaceDisposalStarted || workspaceDisposed) return;
    workspaceCloseAuthorizedImpact = confirmedImpact;
    workspaceDisposalStarted = true;
    await disposeWorkspaceBeforeQuit();
  })();
});

async function disposeWorkspaceBeforeQuit(): Promise<void> {
  for (let attempt = 1; attempt <= workspaceDisposalAttempts; attempt += 1) {
    try {
      await withTimeout(
        workspace.dispose(),
        workspaceDisposalTimeoutMs,
        'Workspace disposal timed out.',
      );
      workspaceDisposed = true;
      app.quit();
      return;
    } catch (error) {
      console.error(`Workspace disposal attempt ${attempt} failed.`, error);
    }
  }
  app.exit(1);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
