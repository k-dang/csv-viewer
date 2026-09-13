import { RendererWorkspace } from '@csv-viewer/ui/renderer-workspace';
import { confirmTabClose } from '@csv-viewer/ui/confirm-tab-close';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@csv-viewer/ui/App';
import { applyTheme, getInitialTheme } from '@csv-viewer/ui/theme';
import { CsvViewerProvider } from '@csv-viewer/ui/csv-viewer';
import '@csv-viewer/ui/styles.css';
import { pickPortableCsvSource } from './portable-csv-picker';
import { disposeWorkspaceWhenPageHides, startWebCsvViewer } from './web-composition';
import { createWebDuckDb } from './web-duckdb';
import { WebStartupState } from './web-startup-state';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('CSV Viewer Web root element was not found.');
const root = createRoot(rootElement);

applyTheme(getInitialTheme());
root.render(<WebStartupState status="checking" />);

const startupController = new AbortController();
const startup = startWebCsvViewer(createWebDuckDb(), pickPortableCsvSource, undefined, startupController.signal);
let workspace: RendererWorkspace | null = null;
let stopped = false;
const dispose = disposeWorkspaceWhenPageHides({
  dispose: async () => {
    stopped = true;
    startupController.abort();
    try {
      root.unmount();
      workspace?.dispose();
    } finally {
      const started = await startup;
      if (started.status === 'ready') await started.viewer.dispose();
    }
  },
});
import.meta.hot?.dispose(dispose);

void startup.then((started) => {
  if (stopped) return;
  if (started.status === 'unsupported') {
    root.render(<WebStartupState status="unsupported" />);
    return;
  }
  workspace = new RendererWorkspace(started.viewer, {
    confirmClose: confirmTabClose,
    acquireDroppedSource: started.acquireDroppedSource,
  });
  root.render(
    <StrictMode>
      <CsvViewerProvider viewer={started.viewer}>
        <App workspace={workspace} />
      </CsvViewerProvider>
    </StrictMode>,
  );
}).catch((error) => {
  console.error('CSV Viewer Web startup failed.', error);
  if (!stopped) root.render(<WebStartupState status="unsupported" />);
});
