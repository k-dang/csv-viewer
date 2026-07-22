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
import { CsvDataService } from './csv-data-service';
import {
  ipcChannels,
  type CsvCellEditRequest,
  type CsvCellEditResult,
  type CsvCloseResult,
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
const csvDataService = new CsvDataService();
const maxRecentFiles = 8;

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
    const dirtySessions = csvDataService.getDirtySessions();

    if (closeAllowed || dirtySessions.length === 0) {
      return;
    }

    event.preventDefault();
    void (async () => {
      const canClose = await confirmDiscardChanges(
        mainWindow,
        dirtySessions.map((session) => session.file.name),
      );

      if (canClose) {
        closeAllowed = true;
        mainWindow.close();
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

  ipcMain.handle(ipcChannels.openCsv, async (_event, options?: CsvDialectOptions): Promise<OpenCsvResult> => {
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
  });

  ipcMain.handle(
    ipcChannels.openRecentCsv,
    async (_event, filePath: string, options?: CsvDialectOptions): Promise<OpenCsvResult> => {
      return openCsvAsTab(filePath, options);
    },
  );

  ipcMain.handle(
    ipcChannels.reopenCsv,
    async (_event, sessionId: string, options?: CsvDialectOptions): Promise<OpenCsvResult> => {
      const ownerWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const existing = csvDataService.getSession(sessionId);

      if (!existing) {
        return { status: 'cancelled' };
      }

      if (csvDataService.isDirty(sessionId)) {
        const canContinue = await confirmDiscardChanges(ownerWindow, [existing.file.name]);

        if (!canContinue) {
          return { status: 'cancelled' };
        }
      }

      const session = await csvDataService.reopenSession(sessionId, options);
      await recordRecentFile(session.file);
      return { status: 'opened', session };
    },
  );

  ipcMain.handle(
    ipcChannels.closeCsv,
    async (_event, sessionId: string): Promise<CsvCloseResult> => {
      const ownerWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const existing = csvDataService.getSession(sessionId);

      if (!existing) {
        return { status: 'closed' };
      }

      if (csvDataService.isDirty(sessionId)) {
        const canContinue = await confirmDiscardChanges(ownerWindow, [existing.file.name]);

        if (!canContinue) {
          return { status: 'cancelled' };
        }
      }

      await csvDataService.closeSession(sessionId);
      return { status: 'closed' };
    },
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
      return csvDataService.getEditState(request);
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
      return csvDataService.undoEdit(request);
    },
  );

  ipcMain.handle(
    ipcChannels.redoCsvEdit,
    async (_event, request: CsvEditStateRequest): Promise<CsvEditState> => {
      return csvDataService.redoEdit(request);
    },
  );
}

async function openCsvAsTab(filePath: string, options?: CsvDialectOptions): Promise<OpenCsvResult> {
  const existing = csvDataService.findSessionByPath(filePath);

  if (existing) {
    return { status: 'already-open', session: existing };
  }

  const session = await csvDataService.openCsv(filePath, options);
  await recordRecentFile(session.file);
  return { status: 'opened', session };
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

async function saveCsvAsForSession(
  ownerWindow: BrowserWindow | undefined,
  request: CsvSaveAsRequest,
): Promise<CsvEditState | null> {
  const session = csvDataService.getSession(request.sessionId);

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

  return csvDataService.saveAs(request, result.filePath);
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

app.on('before-quit', () => {
  void csvDataService.closeAllSessions();
});
