import { contextBridge, ipcRenderer } from 'electron';
import { ipcChannels } from '../shared/ipc-channels';
import { isCsvViewerIntent, type CsvViewerRuntime } from '../shared/csv-viewer-contract';

const runtime: CsvViewerRuntime = {
  capabilities: { recentCsvSources: true },
  healthCheck: () => ipcRenderer.invoke(ipcChannels.healthCheck),
  openCsv: (options) => ipcRenderer.invoke(ipcChannels.openCsv, options),
  openRecentCsv: (sourceId, options) =>
    ipcRenderer.invoke(ipcChannels.openRecentCsv, sourceId, options),
  reopenCsv: (workingCsvId, options) => ipcRenderer.invoke(ipcChannels.reopenCsv, workingCsvId, options),
  closeCsv: (request) => ipcRenderer.invoke(ipcChannels.closeCsv, request),
  getComparisonCandidates: (baselineId) =>
    ipcRenderer.invoke(ipcChannels.getComparisonCandidates, baselineId),
  openComparison: (request) => ipcRenderer.invoke(ipcChannels.openComparison, request),
  getComparisonState: (comparisonId) =>
    ipcRenderer.invoke(ipcChannels.getComparisonState, comparisonId),
  beginComparison: (request) => ipcRenderer.invoke(ipcChannels.beginComparison, request),
  cancelComparison: (request) => ipcRenderer.invoke(ipcChannels.cancelComparison, request),
  getComparisonWindow: (request) => ipcRenderer.invoke(ipcChannels.getComparisonWindow, request),
  swapComparison: (comparisonId) => ipcRenderer.invoke(ipcChannels.swapComparison, comparisonId),
  closeComparison: (comparisonId) => ipcRenderer.invoke(ipcChannels.closeComparison, comparisonId),
  getRecentCsvSources: () => ipcRenderer.invoke(ipcChannels.getRecentCsvSources),
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
  onIntent: (callback) => {
    // The bridge is a trust boundary: only a known intent reaches React.
    const listener = (_event: Electron.IpcRendererEvent, intent: unknown) => {
      if (isCsvViewerIntent(intent)) callback(intent);
    };
    ipcRenderer.on(ipcChannels.intent, listener);
    return () => ipcRenderer.removeListener(ipcChannels.intent, listener);
  },
  onComparisonEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: Parameters<typeof callback>[0]) =>
      callback(value);
    ipcRenderer.on(ipcChannels.comparisonStateChanged, listener);
    return () => ipcRenderer.removeListener(ipcChannels.comparisonStateChanged, listener);
  },
};

contextBridge.exposeInMainWorld('csvViewer', runtime);
