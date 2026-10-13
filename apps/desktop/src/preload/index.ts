import { contextBridge, ipcRenderer, webUtils } from 'electron';

// SAFETY: The preload and the page share this window. postMessage transfers the MessagePort.
const page = globalThis as typeof globalThis & {
  postMessage(message: { type: 'csv-viewer-port' }, targetOrigin: string, transfer?: ReadonlyArray<object>): void;
};

ipcRenderer.on('csv-viewer-port', (event) => {
  page.postMessage({ type: 'csv-viewer-port' }, '*', event.ports);
});

contextBridge.exposeInMainWorld('csvViewerPathForFile', (file: File) => webUtils.getPathForFile(file));
