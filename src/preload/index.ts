import { contextBridge, ipcRenderer } from 'electron';
import { type CsvViewerApi, ipcChannels } from '../shared/ipc';

const api: CsvViewerApi = {
  healthCheck: () => ipcRenderer.invoke(ipcChannels.healthCheck),
  openCsv: (options) => ipcRenderer.invoke(ipcChannels.openCsv, options),
  openRecentCsv: (filePath, options) => ipcRenderer.invoke(ipcChannels.openRecentCsv, filePath, options),
  reopenCsv: (options) => ipcRenderer.invoke(ipcChannels.reopenCsv, options),
  getRecentFiles: () => ipcRenderer.invoke(ipcChannels.getRecentFiles),
  getCsvRows: (request) => ipcRenderer.invoke(ipcChannels.getCsvRows, request),
};

contextBridge.exposeInMainWorld('csvViewer', api);
