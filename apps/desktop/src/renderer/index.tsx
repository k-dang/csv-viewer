import { RendererWorkspace } from '@csv-viewer/ui/renderer-workspace';
import { confirmTabClose } from '@csv-viewer/ui/confirm-tab-close';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@csv-viewer/ui/App';
import { applyPalette, applyTheme, getInitialPalette, getInitialTheme } from '@csv-viewer/ui/theme';
import { CsvViewerProvider } from '@csv-viewer/ui/csv-viewer';
import '@csv-viewer/ui/styles.css';
import { connectBrowserMessagePort } from '@csv-viewer/workspace/csv-viewer-client';
import { electronCsvViewerCapabilities } from '../electron-csv-viewer-capabilities';
import { pathForDroppedFile } from './electron-csv-viewer';

const root = document.getElementById('root');
if (!root) throw new Error('CSV Viewer root element was not found.');

const reactRoot = createRoot(root);
applyTheme(getInitialTheme());
applyPalette(getInitialPalette());

let workspace: RendererWorkspace | undefined;

function dispose() {
  window.removeEventListener('pagehide', dispose);
  reactRoot.unmount();
  workspace?.dispose();
  void window.csvViewer?.close();
}
window.addEventListener('pagehide', dispose, { once: true });
import.meta.hot?.dispose(dispose);

window.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'csv-viewer-port') return;
  const port = event.ports[0];
  if (!port || window.csvViewer) return;
  void connectBrowserMessagePort(port, electronCsvViewerCapabilities).then((viewer) => {
    window.csvViewer = viewer;
    workspace = new RendererWorkspace(viewer, {
      confirmClose: confirmTabClose,
      acquireDroppedSource: (file) => viewer.acquireDroppedPath(pathForDroppedFile(file)),
    });
    reactRoot.render(
      <StrictMode>
        <CsvViewerProvider viewer={viewer}>
          <App workspace={workspace} />
        </CsvViewerProvider>
      </StrictMode>,
    );
  });
});
