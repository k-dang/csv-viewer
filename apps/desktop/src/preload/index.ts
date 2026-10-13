import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { authorizeDroppedPathChannel } from '../dropped-path-channel';

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

contextBridge.exposeInMainWorld('csvViewerPathForFile', (file: File) => {
  const filePath = webUtils.getPathForFile(file);
  if (!filePath) return '';
  // The page receives the path only after main has recorded this native path.
  const recorded = ipcRenderer.sendSync(authorizeDroppedPathChannel, filePath);
  return recorded === true ? filePath : '';
});
