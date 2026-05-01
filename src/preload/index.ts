import { contextBridge, ipcRenderer } from 'electron';
import { type CsvViewerApi, ipcChannels } from '../shared/ipc';

const api: CsvViewerApi = {
  healthCheck: () => ipcRenderer.invoke(ipcChannels.healthCheck),
  openCsv: () => ipcRenderer.invoke(ipcChannels.openCsv),
  getCsvRows: (request) => ipcRenderer.invoke(ipcChannels.getCsvRows, request),
};

contextBridge.exposeInMainWorld('csvViewer', api);
