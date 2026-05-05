import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  type BrowserWindowConstructorOptions,
  type MessageBoxOptions,
  type MenuItemConstructorOptions,
  type SaveDialogOptions,
} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CsvDataService } from './csv-data-service';
import {
  ipcChannels,
  type CsvCellEditRequest,
  type CsvCellEditResult,
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
    if (closeAllowed || !csvDataService.hasUnsavedChanges()) {
      return;
    }

    event.preventDefault();
    void (async () => {
      const canClose = await resolveUnsavedChanges(mainWindow);

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
  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      {
        label: 'Open CSV...',
        accelerator: 'CmdOrCtrl+O',
        click: () => {
          sendMenuRequest(ipcChannels.menuOpenCsv);
        },
      },
      {
        label: 'Reopen CSV',
        accelerator: 'CmdOrCtrl+R',
        click: () => {
          sendMenuRequest(ipcChannels.menuReopenCsv);
        },
      },
      { type: 'separator' },
      process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { role: 'reload' },
      ...(isDevelopment ? ([{ role: 'toggleDevTools' }, { type: 'separator' }] as MenuItemConstructorOptions[]) : []),
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: [{ role: 'minimize' }, { role: 'close' }],
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: 'Help',
    submenu: [
      {
        label: 'About CSV Viewer',
        click: () => {
          const ownerWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
          void dialog.showMessageBox(ownerWindow, {
            type: 'info',
            title: 'About CSV Viewer',
            message: 'CSV Viewer',
            detail: 'A desktop viewer for opening, inspecting, filtering, and sorting CSV-style files.',
          });
        },
      },
    ],
  };

  const template: MenuItemConstructorOptions[] =
    process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }],
          },
          fileMenu,
          viewMenu,
          windowMenu,
          helpMenu,
        ]
      : [fileMenu, viewMenu, windowMenu, helpMenu];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function sendMenuRequest(channel: typeof ipcChannels.menuOpenCsv | typeof ipcChannels.menuReopenCsv) {
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
    const ownerWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const canContinue = await resolveUnsavedChanges(ownerWindow);

    if (!canContinue) {
      return { status: 'cancelled' };
    }

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

    const session = await csvDataService.openCsv(result.filePaths[0], options);
    await recordRecentFile(session.file);
    return { status: 'opened', session };
  });

  ipcMain.handle(
    ipcChannels.openRecentCsv,
    async (_event, filePath: string, options?: CsvDialectOptions): Promise<OpenCsvResult> => {
      const ownerWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const canContinue = await resolveUnsavedChanges(ownerWindow);

      if (!canContinue) {
        return { status: 'cancelled' };
      }

      const session = await csvDataService.openCsv(filePath, options);
      await recordRecentFile(session.file);
      return { status: 'opened', session };
    },
  );

  ipcMain.handle(ipcChannels.reopenCsv, async (_event, options?: CsvDialectOptions): Promise<OpenCsvResult> => {
    const ownerWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const canContinue = await resolveUnsavedChanges(ownerWindow);

    if (!canContinue) {
      return { status: 'cancelled' };
    }

    const session = await csvDataService.reopenActiveCsv(options);
    await recordRecentFile(session.file);
    return { status: 'opened', session };
  });

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
      const saved = await saveActiveCsvAs(ownerWindow, request);
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

async function resolveUnsavedChanges(ownerWindow?: BrowserWindow): Promise<boolean> {
  if (!csvDataService.hasUnsavedChanges()) {
    return true;
  }

  const messageOptions: MessageBoxOptions = {
    type: 'warning',
    title: 'Unsaved CSV changes',
    message: 'Save changes before continuing?',
    detail: 'Your edits have not been saved. Save As writes a new CSV file and leaves the original unchanged.',
    buttons: ['Save As...', 'Discard', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
  const result = ownerWindow
    ? await dialog.showMessageBox(ownerWindow, messageOptions)
    : await dialog.showMessageBox(messageOptions);

  if (result.response === 2) {
    return false;
  }

  if (result.response === 1) {
    return true;
  }

  try {
    return Boolean(await saveActiveCsvAs(ownerWindow));
  } catch (error: unknown) {
    showSaveError(ownerWindow, error);
    return false;
  }
}

async function saveActiveCsvAs(
  ownerWindow?: BrowserWindow,
  request?: CsvSaveAsRequest,
): Promise<CsvEditState | null> {
  const activeSession = csvDataService.getActiveSession();

  if (!activeSession) {
    return null;
  }

  const saveOptions: SaveDialogOptions = {
    title: 'Save CSV As',
    defaultPath: buildDefaultSaveAsPath(activeSession.file.path),
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

  return csvDataService.saveAs(request ?? { sessionId: activeSession.sessionId }, result.filePath);
}

function buildDefaultSaveAsPath(filePath: string): string {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}-edited${parsed.ext || '.csv'}`);
}

function showSaveError(ownerWindow: BrowserWindow | undefined, error: unknown): void {
  const messageOptions: MessageBoxOptions = {
    type: 'error',
    title: 'Unable to save CSV',
    message: 'Unable to save the edited CSV.',
    detail: error instanceof Error ? error.message : 'The save operation failed.',
  } as const;

  void (ownerWindow
    ? dialog.showMessageBox(ownerWindow, messageOptions)
    : dialog.showMessageBox(messageOptions));
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
  void csvDataService.closeActiveSession();
});
