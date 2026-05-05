import { contextBridge, ipcRenderer } from 'electron';
import { type CsvViewerApi, ipcChannels } from '../shared/ipc';

const api: CsvViewerApi = {
  healthCheck: () => ipcRenderer.invoke(ipcChannels.healthCheck),
  openCsv: (options) => ipcRenderer.invoke(ipcChannels.openCsv, options),
  openRecentCsv: (filePath, options) => ipcRenderer.invoke(ipcChannels.openRecentCsv, filePath, options),
  reopenCsv: (options) => ipcRenderer.invoke(ipcChannels.reopenCsv, options),
  getRecentFiles: () => ipcRenderer.invoke(ipcChannels.getRecentFiles),
  getCsvRows: (request) => ipcRenderer.invoke(ipcChannels.getCsvRows, request),
  editCsvCell: (request) => ipcRenderer.invoke(ipcChannels.editCsvCell, request),
  deleteCsvRows: (request) => ipcRenderer.invoke(ipcChannels.deleteCsvRows, request),
  insertCsvRow: (request) => ipcRenderer.invoke(ipcChannels.insertCsvRow, request),
  getCsvEditState: (request) => ipcRenderer.invoke(ipcChannels.getCsvEditState, request),
  undoCsvEdit: (request) => ipcRenderer.invoke(ipcChannels.undoCsvEdit, request),
  redoCsvEdit: (request) => ipcRenderer.invoke(ipcChannels.redoCsvEdit, request),
  onOpenCsvRequest: (callback) => {
    ipcRenderer.on(ipcChannels.menuOpenCsv, callback);
    return () => ipcRenderer.removeListener(ipcChannels.menuOpenCsv, callback);
  },
  onReopenCsvRequest: (callback) => {
    ipcRenderer.on(ipcChannels.menuReopenCsv, callback);
    return () => ipcRenderer.removeListener(ipcChannels.menuReopenCsv, callback);
  },
};

contextBridge.exposeInMainWorld('csvViewer', api);
