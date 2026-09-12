import { RendererWorkspace } from '@csv-viewer/ui/renderer-workspace';
import { confirmTabClose } from '@csv-viewer/ui/confirm-tab-close';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@csv-viewer/ui/App';
import { applyTheme, getInitialTheme } from '@csv-viewer/ui/theme';
import { CsvViewerProvider } from '@csv-viewer/ui/csv-viewer';
import '@csv-viewer/ui/styles.css';
import { electronCsvViewer } from './electron-csv-viewer';

const root = document.getElementById('root');
if (!root) throw new Error('CSV Viewer root element was not found.');

const viewer = electronCsvViewer();
const workspace = new RendererWorkspace(viewer, { confirmClose: confirmTabClose });
const reactRoot = createRoot(root);

function dispose() {
  window.removeEventListener('pagehide', dispose);
  reactRoot.unmount();
  workspace.dispose();
}
window.addEventListener('pagehide', dispose, { once: true });
import.meta.hot?.dispose(dispose);

applyTheme(getInitialTheme());
reactRoot.render(
  <StrictMode>
    <CsvViewerProvider viewer={viewer}>
      <App workspace={workspace} />
    </CsvViewerProvider>
  </StrictMode>,
);
