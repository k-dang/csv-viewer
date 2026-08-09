import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  type BrowserWindowConstructorOptions,
  type MessageBoxOptions,
  type SaveDialogOptions,
} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApplicationMenuTemplate } from './application-menu';
import { CsvWorkspace, type WorkspaceCloseImpact } from './csv-workspace';
import {
  ipcChannels,
  type BeginComparisonRequest,
  type BeginComparisonIpcResult,
  type CancelComparisonRequest,
  type CancelComparisonResult,
  type CloseComparisonResult,
  type ComparisonCandidate,
  type ComparisonEvent,
  type ComparisonMutationOutcome,
  type ComparisonView,
  type ComparisonWindowOutcome,
  type ComparisonWindowRequest,
  type CsvCellEditRequest,
  type CsvCellEditResult,
  type CloseWorkingCsvOutcome,
  type CloseWorkingCsvRequest,
  type CsvColumnValueCounts,
  type CsvColumnValueCountsRequest,
  type CsvDeleteRowsRequest,
  type CsvDialectOptions,
  type CsvEditState,
  type CsvEditStateRequest,
  type CsvFileMetadata,
  type CsvInsertRowRequest,
  type RecentCsvFile,
  type CsvRowWindow,
  type CsvRowWindowRequest,
  type CsvSaveAsRequest,
  type HealthStatus,
  type OpenCsvResult,
} from '../shared/ipc';

const electronRoot = __dirname;
const workspace = new CsvWorkspace();
const csvDataService = workspace.csvs;
const csvComparisonService = workspace.comparisons;
const maxRecentFiles = 8;
let workspaceCloseAuthorizedImpact: WorkspaceCloseImpact | undefined;
let workspaceCloseConfirmation: Promise<WorkspaceCloseImpact | null> | null = null;

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);

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
    const initial = workspace.confirmWindowClose();
    if (initial.status === 'ready') return;

    event.preventDefault();
    void (async () => {
      const confirmedImpact = await confirmWorkspaceCloseOnce(mainWindow, initial.impact);
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
    onOpenCsv: () => sendMenuRequest(ipcChannels.menuOpenCsv),
    onReopenCsv: () => sendMenuRequest(ipcChannels.menuReopenCsv),
    onCloseTab: () => sendMenuRequest(ipcChannels.menuCloseTab),
    onAbout: () => {
      const ownerWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      void dialog.showMessageBox(ownerWindow, {
        type: 'info',
        title: 'About CSV Viewer',
        message: 'CSV Viewer',
        detail: 'A desktop viewer for opening, inspecting, filtering, and sorting CSV-style files.',
      });
    },
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function sendMenuRequest(
  channel:
    | typeof ipcChannels.menuOpenCsv
    | typeof ipcChannels.menuReopenCsv
    | typeof ipcChannels.menuCloseTab,
) {
  const targetWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  targetWindow?.webContents.send(channel);
}

function registerIpcHandlers() {
  ipcMain.handle(ipcChannels.healthCheck, (): HealthStatus => {
    return {
      ok: true,
      process: 'main',
      timestamp: new Date().toISOString(),
    };
  });

  ipcMain.handle(
    ipcChannels.openCsv,
    async (_event, options?: CsvDialectOptions): Promise<OpenCsvResult> => {
      const result = await dialog.showOpenDialog({
        title: 'Open CSV',
        properties: ['openFile'],
        filters: [
          { name: 'CSV files', extensions: ['csv', 'tsv', 'txt'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { status: 'cancelled' };
      }

      return openCsvAsTab(result.filePaths[0], options);
    },
  );

  ipcMain.handle(
    ipcChannels.openRecentCsv,
    async (_event, filePath: string, options?: CsvDialectOptions): Promise<OpenCsvResult> => {
      return openCsvAsTab(filePath, options);
    },
  );

  ipcMain.handle(
    ipcChannels.reopenCsv,
    async (_event, workingCsvId: string, options?: CsvDialectOptions): Promise<OpenCsvResult> => {
      const ownerWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const existing = csvDataService.getState(workingCsvId);

      if (!existing) {
        return { status: 'cancelled' };
      }

      if (existing.editState.dirty) {
        const canContinue = await confirmDiscardChanges(ownerWindow, [existing.file.name]);

        if (!canContinue) {
          return { status: 'cancelled' };
        }
      }

      const replacement = await csvDataService.replace(workingCsvId, options);
      if (replacement.status === 'working-csv-not-found') return { status: 'cancelled' };
      if (replacement.status === 'failed') {
        return { status: 'failed', message: replacement.failure.message };
      }
      await recordRecentFile(replacement.workingCsv.file);
      return { status: 'opened', session: replacement.workingCsv };
    },
  );

  ipcMain.handle(
    ipcChannels.closeCsv,
    (_event, request: CloseWorkingCsvRequest): Promise<CloseWorkingCsvOutcome> =>
      workspace.closeWorkingCsv(request),
  );

  ipcMain.handle(
    ipcChannels.getComparisonCandidates,
    (_event, baselineId: string): ComparisonCandidate[] =>
      csvComparisonService.candidatesFor(baselineId),
  );

  ipcMain.handle(ipcChannels.openComparison, (_event, baselineId: string, candidateId: string) =>
    csvComparisonService.open({ baselineId, candidateId }),
  );

  ipcMain.handle(
    ipcChannels.getComparisonState,
    (_event, comparisonId: string): ComparisonView | null =>
      csvComparisonService.getState(comparisonId),
  );

  ipcMain.handle(
    ipcChannels.beginComparison,
    (_event, request: BeginComparisonRequest): BeginComparisonIpcResult => {
      const result = csvComparisonService.begin(request);
      if (result.status !== 'accepted') return result;
      void result.completion.catch((error) => {
        console.error(`Comparison operation ${result.operationId} failed unexpectedly.`, error);
      });
      return { status: 'accepted', operationId: result.operationId };
    },
  );

  ipcMain.handle(
    ipcChannels.cancelComparison,
    (_event, request: CancelComparisonRequest): Promise<CancelComparisonResult> =>
      csvComparisonService.cancel(request),
  );

  ipcMain.handle(
    ipcChannels.getComparisonWindow,
    async (_event, request: ComparisonWindowRequest): Promise<ComparisonWindowOutcome> =>
      csvComparisonService.getWindow(request),
  );

  ipcMain.handle(
    ipcChannels.swapComparison,
    (_event, comparisonId: string): ComparisonMutationOutcome =>
      csvComparisonService.swap(comparisonId),
  );

  ipcMain.handle(
    ipcChannels.closeComparison,
    async (_event, comparisonId: string): Promise<CloseComparisonResult> =>
      csvComparisonService.close(comparisonId),
  );

  ipcMain.handle(ipcChannels.getRecentFiles, async (): Promise<RecentCsvFile[]> => {
    return readRecentFiles();
  });

  ipcMain.handle(
    ipcChannels.getCsvRows,
    async (_event, request: CsvRowWindowRequest): Promise<CsvRowWindow> => {
      return csvDataService.getRows(request);
    },
  );

  ipcMain.handle(
    ipcChannels.getCsvColumnValueCounts,
    async (_event, request: CsvColumnValueCountsRequest): Promise<CsvColumnValueCounts> => {
      return csvDataService.getColumnValueCounts(request);
    },
  );

  ipcMain.handle(
    ipcChannels.editCsvCell,
    async (_event, request: CsvCellEditRequest): Promise<CsvCellEditResult> => {
      return csvDataService.editCell(request);
    },
  );

  ipcMain.handle(
    ipcChannels.deleteCsvRows,
    async (_event, request: CsvDeleteRowsRequest): Promise<CsvEditState> => {
      return csvDataService.deleteRows(request);
    },
  );

  ipcMain.handle(
    ipcChannels.insertCsvRow,
    async (_event, request: CsvInsertRowRequest): Promise<CsvEditState> => {
      return csvDataService.insertRow(request);
    },
  );

  ipcMain.handle(
    ipcChannels.getCsvEditState,
    (_event, request: CsvEditStateRequest): CsvEditState => {
      const workingCsv = csvDataService.getState(request.workingCsvId);
      if (!workingCsv) throw new Error('Working CSV is no longer active.');
      return workingCsv.editState;
    },
  );

  ipcMain.handle(
    ipcChannels.saveCsvAs,
    async (_event, request: CsvSaveAsRequest): Promise<CsvEditState | { status: 'cancelled' }> => {
      const ownerWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const saved = await saveCsvAsForSession(ownerWindow, request);
      return saved ?? { status: 'cancelled' };
    },
  );

  ipcMain.handle(
    ipcChannels.undoCsvEdit,
    async (_event, request: CsvEditStateRequest): Promise<CsvEditState> => {
      return csvDataService.undo(request.workingCsvId);
    },
  );

  ipcMain.handle(
    ipcChannels.redoCsvEdit,
    async (_event, request: CsvEditStateRequest): Promise<CsvEditState> => {
      return csvDataService.redo(request.workingCsvId);
    },
  );
}

async function openCsvAsTab(filePath: string, options?: CsvDialectOptions): Promise<OpenCsvResult> {
  const outcome = await csvDataService.open(filePath, options);
  if (outcome.status === 'failed') return { status: 'failed', message: outcome.failure.message };
  if (outcome.status === 'existing') {
    return { status: 'already-open', session: outcome.workingCsv };
  }
  await recordRecentFile(outcome.workingCsv.file);
  return { status: 'opened', session: outcome.workingCsv };
}

async function confirmDiscardChanges(
  ownerWindow: BrowserWindow | undefined,
  fileNames: string[],
): Promise<boolean> {
  const messageOptions: MessageBoxOptions = {
    type: 'warning',
    title: 'Unsaved CSV changes',
    message:
      fileNames.length === 1
        ? `Discard unsaved changes to ${fileNames[0]}?`
        : 'Discard unsaved changes?',
    detail:
      fileNames.length === 1
        ? 'Your edits have not been saved and will be lost.'
        : `These files have unsaved edits that will be lost:\n${fileNames.join('\n')}`,
    buttons: ['Discard', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const result = ownerWindow
    ? await dialog.showMessageBox(ownerWindow, messageOptions)
    : await dialog.showMessageBox(messageOptions);

  return result.response === 0;
}

async function confirmWorkspaceClose(
  ownerWindow: BrowserWindow | undefined,
  impact: WorkspaceCloseImpact,
): Promise<boolean> {
  const details: string[] = [];
  if (impact.dirtyWorkingCsvs.length > 0) {
    details.push(
      `Unsaved edits will be lost:\n${impact.dirtyWorkingCsvs.map((csv) => csv.fileName).join('\n')}`,
    );
  }
  if (impact.dependentComparisons.length > 0) {
    details.push(
      `Open comparisons will close:\n${impact.dependentComparisons
        .map((comparison) => `${comparison.baselineName} ↔ ${comparison.candidateName}`)
        .join('\n')}`,
    );
  }
  const messageOptions: MessageBoxOptions = {
    type: 'warning',
    title: 'Close CSV Viewer',
    message: 'Close CSV Viewer?',
    detail: details.join('\n\n'),
    buttons: ['Close', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const result = ownerWindow
    ? await dialog.showMessageBox(ownerWindow, messageOptions)
    : await dialog.showMessageBox(messageOptions);
  return result.response === 0;
}

async function confirmCurrentWorkspaceImpact(
  ownerWindow: BrowserWindow | undefined,
  initialImpact: WorkspaceCloseImpact,
): Promise<WorkspaceCloseImpact | null> {
  let impact = initialImpact;
  while (await confirmWorkspaceClose(ownerWindow, impact)) {
    const rechecked = workspace.confirmWindowClose(impact);
    if (rechecked.status === 'ready') return impact;
    impact = rechecked.impact;
  }
  return null;
}

function confirmWorkspaceCloseOnce(
  ownerWindow: BrowserWindow | undefined,
  impact: WorkspaceCloseImpact,
): Promise<WorkspaceCloseImpact | null> {
  if (!workspaceCloseConfirmation) {
    workspaceCloseConfirmation = confirmCurrentWorkspaceImpact(ownerWindow, impact).finally(() => {
      workspaceCloseConfirmation = null;
    });
  }
  return workspaceCloseConfirmation;
}

async function saveCsvAsForSession(
  ownerWindow: BrowserWindow | undefined,
  request: CsvSaveAsRequest,
): Promise<CsvEditState | null> {
  const session = csvDataService.getState(request.workingCsvId);

  if (!session) {
    return null;
  }

  const saveOptions: SaveDialogOptions = {
    title: 'Save CSV As',
    defaultPath: buildDefaultSaveAsPath(session.file.path),
    filters: [
      { name: 'CSV files', extensions: ['csv'] },
      { name: 'Text files', extensions: ['txt', 'tsv'] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  const result = ownerWindow
    ? await dialog.showSaveDialog(ownerWindow, saveOptions)
    : await dialog.showSaveDialog(saveOptions);

  if (result.canceled || !result.filePath) {
    return null;
  }

  return csvDataService.saveAs(request.workingCsvId, result.filePath);
}

function buildDefaultSaveAsPath(filePath: string): string {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}-edited${parsed.ext || '.csv'}`);
}

function getRecentFilesPath(): string {
  return path.join(app.getPath('userData'), 'recent-files.json');
}

async function readRecentFiles(): Promise<RecentCsvFile[]> {
  try {
    const raw = await fs.readFile(getRecentFilesPath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isRecentCsvFile).slice(0, maxRecentFiles);
  } catch (error: unknown) {
    if (isFileSystemError(error) && error.code === 'ENOENT') {
      return [];
    }

    console.warn('Unable to read recent CSV files.', error);
    return [];
  }
}

async function recordRecentFile(file: CsvFileMetadata): Promise<void> {
  const recentFiles = await readRecentFiles();
  const normalizedPath = path.resolve(file.path);
  const nextRecentFiles = [
    { ...file, path: normalizedPath, lastOpenedAt: new Date().toISOString() },
    ...recentFiles.filter((recentFile) => path.resolve(recentFile.path) !== normalizedPath),
  ].slice(0, maxRecentFiles);

  try {
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(getRecentFilesPath(), JSON.stringify(nextRecentFiles, null, 2), 'utf8');
  } catch (error: unknown) {
    console.warn('Unable to write recent CSV files.', error);
  }
}

function isRecentCsvFile(value: unknown): value is RecentCsvFile {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<RecentCsvFile>;
  return (
    typeof candidate.path === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.sizeBytes === 'number' &&
    typeof candidate.lastOpenedAt === 'string'
  );
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

app.whenReady().then(() => {
  registerContentSecurityPolicy();
  createApplicationMenu();
  registerIpcHandlers();
  csvComparisonService.subscribe((event: ComparisonEvent) => {
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
  const impact = workspace.confirmWindowClose(workspaceCloseAuthorizedImpact);
  if (impact.status === 'ready') {
    workspaceDisposalStarted = true;
    void disposeWorkspaceBeforeQuit();
    return;
  }
  void (async () => {
    const confirmedImpact = await confirmWorkspaceCloseOnce(
      BrowserWindow.getFocusedWindow() ?? undefined,
      impact.impact,
    );
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
