import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@csv-viewer/ui/App';
import { CsvViewerProvider } from '@csv-viewer/ui/csv-viewer';
import '@csv-viewer/ui/styles.css';
import { electronCsvViewer } from './electron-csv-viewer';

const root = document.getElementById('root');
if (!root) throw new Error('CSV Viewer root element was not found.');

createRoot(root).render(
  <StrictMode>
    <CsvViewerProvider viewer={electronCsvViewer()}>
      <App />
    </CsvViewerProvider>
  </StrictMode>,
);
