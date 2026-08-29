import { contextBridge, ipcRenderer } from 'electron';
import { createElectronCsvViewer } from './electron-csv-viewer';

contextBridge.exposeInMainWorld('csvViewer', createElectronCsvViewer(ipcRenderer));
