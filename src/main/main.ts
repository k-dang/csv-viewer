import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  type BrowserWindowConstructorOptions,
  type MenuItemConstructorOptions,
} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CsvDataService } from './csv-data-service';
import {
  ipcChannels,
  type CsvDialectOptions,
  type CsvFileMetadata,
  type RecentCsvFile,
  type CsvRowWindow,
  type CsvRowWindowRequest,
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
      const session = await csvDataService.openCsv(filePath, options);
      await recordRecentFile(session.file);
      return { status: 'opened', session };
    },
  );

  ipcMain.handle(ipcChannels.reopenCsv, async (_event, options?: CsvDialectOptions): Promise<OpenCsvResult> => {
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
