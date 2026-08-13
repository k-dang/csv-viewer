import { contextBridge, ipcRenderer } from 'electron';
import { type CsvViewerApi, ipcChannels } from '../shared/ipc';

const api: CsvViewerApi = {
  healthCheck: () => ipcRenderer.invoke(ipcChannels.healthCheck),
  openCsv: (options) => ipcRenderer.invoke(ipcChannels.openCsv, options),
  openRecentCsv: (filePath, options) =>
    ipcRenderer.invoke(ipcChannels.openRecentCsv, filePath, options),
  reopenCsv: (workingCsvId, options) => ipcRenderer.invoke(ipcChannels.reopenCsv, workingCsvId, options),
  closeCsv: (request) => ipcRenderer.invoke(ipcChannels.closeCsv, request),
  getComparisonCandidates: (baselineId) =>
    ipcRenderer.invoke(ipcChannels.getComparisonCandidates, baselineId),
  openComparison: (baselineId, candidateId) =>
    ipcRenderer.invoke(ipcChannels.openComparison, baselineId, candidateId),
  getComparisonState: (comparisonId) =>
    ipcRenderer.invoke(ipcChannels.getComparisonState, comparisonId),
  beginComparison: (request) => ipcRenderer.invoke(ipcChannels.beginComparison, request),
  cancelComparison: (request) => ipcRenderer.invoke(ipcChannels.cancelComparison, request),
  getComparisonWindow: (request) => ipcRenderer.invoke(ipcChannels.getComparisonWindow, request),
  swapComparison: (comparisonId) => ipcRenderer.invoke(ipcChannels.swapComparison, comparisonId),
  closeComparison: (comparisonId) => ipcRenderer.invoke(ipcChannels.closeComparison, comparisonId),
  getRecentFiles: () => ipcRenderer.invoke(ipcChannels.getRecentFiles),
  getCsvRows: (request) => ipcRenderer.invoke(ipcChannels.getCsvRows, request),
  getCsvColumnValueCounts: (request) =>
    ipcRenderer.invoke(ipcChannels.getCsvColumnValueCounts, request),
  editCsvCell: (request) => ipcRenderer.invoke(ipcChannels.editCsvCell, request),
  deleteCsvRows: (request) => ipcRenderer.invoke(ipcChannels.deleteCsvRows, request),
  insertCsvRow: (request) => ipcRenderer.invoke(ipcChannels.insertCsvRow, request),
  getCsvEditState: (request) => ipcRenderer.invoke(ipcChannels.getCsvEditState, request),
  exportCsv: (request) => ipcRenderer.invoke(ipcChannels.exportCsv, request),
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
  onExportCsvRequest: (callback) => {
    ipcRenderer.on(ipcChannels.menuExportCsv, callback);
    return () => ipcRenderer.removeListener(ipcChannels.menuExportCsv, callback);
  },
  onCloseTabRequest: (callback) => {
    ipcRenderer.on(ipcChannels.menuCloseTab, callback);
    return () => ipcRenderer.removeListener(ipcChannels.menuCloseTab, callback);
  },
  onComparisonEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: Parameters<typeof callback>[0]) =>
      callback(value);
    ipcRenderer.on(ipcChannels.comparisonStateChanged, listener);
    return () => ipcRenderer.removeListener(ipcChannels.comparisonStateChanged, listener);
  },
};

contextBridge.exposeInMainWorld('csvViewer', api);
