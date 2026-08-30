import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { CsvViewerProvider } from './csv-viewer';
import { electronCsvViewer } from './electron-csv-viewer';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('CSV Viewer root element was not found.');

createRoot(root).render(
  <StrictMode>
    <CsvViewerProvider viewer={electronCsvViewer()}>
      <App />
    </CsvViewerProvider>
  </StrictMode>,
);
