import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { createElectronCsvViewer } from './electron-csv-viewer';
import { ipcChannels } from '../ipc-channels';

contextBridge.exposeInMainWorld('csvViewer', createElectronCsvViewer(ipcRenderer));
contextBridge.exposeInMainWorld('acquireDroppedCsvSource', (file: File) => {
  const filePath = webUtils.getPathForFile(file);
  if (!filePath) throw new Error('Drop a file from your device.');
  return ipcRenderer.invoke(ipcChannels.acquireDroppedSource, filePath);
});
