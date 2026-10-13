import { contextBridge, ipcRenderer, webUtils } from 'electron';

// The isolated preload global is not the page window. The port has to be posted on that window.
declare const window: {
  postMessage(
    message: { type: 'csv-viewer-port' },
    targetOrigin: string,
    transfer?: ReadonlyArray<object>,
  ): void;
};

ipcRenderer.on('csv-viewer-port', (event) => {
  window.postMessage({ type: 'csv-viewer-port' }, '*', event.ports);
});

contextBridge.exposeInMainWorld('csvViewerPathForFile', (file: File) => webUtils.getPathForFile(file));
