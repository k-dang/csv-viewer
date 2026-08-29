import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { CsvViewerProvider } from './csv-viewer';
import { electronCsvViewer } from './electron-csv-viewer';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <CsvViewerProvider viewer={electronCsvViewer()}>
      <App />
    </CsvViewerProvider>
  </StrictMode>,
);
