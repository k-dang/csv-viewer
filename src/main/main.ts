import { app, BrowserWindow, dialog, ipcMain, type BrowserWindowConstructorOptions } from 'electron';
import path from 'node:path';
import { CsvDataService } from './csv-data-service';
import {
  ipcChannels,
  type CsvRowWindow,
  type CsvRowWindowRequest,
  type HealthStatus,
  type OpenCsvResult,
} from '../shared/ipc';

const electronRoot = __dirname;
const csvDataService = new CsvDataService();

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);

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

function registerIpcHandlers() {
  ipcMain.handle(ipcChannels.healthCheck, (): HealthStatus => {
    return {
      ok: true,
      process: 'main',
      timestamp: new Date().toISOString(),
    };
  });

  ipcMain.handle(ipcChannels.openCsv, async (): Promise<OpenCsvResult> => {
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

    const session = await csvDataService.openCsv(result.filePaths[0]);
    return { status: 'opened', session };
  });

  ipcMain.handle(
    ipcChannels.getCsvRows,
    async (_event, request: CsvRowWindowRequest): Promise<CsvRowWindow> => {
      return csvDataService.getRows(request);
    },
  );
}

app.whenReady().then(() => {
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
