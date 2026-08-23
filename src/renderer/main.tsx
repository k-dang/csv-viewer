import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { CsvViewerRuntimeProvider } from './csv-viewer-runtime';
import { electronCsvViewerRuntime } from './electron-runtime';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <CsvViewerRuntimeProvider runtime={electronCsvViewerRuntime()}>
      <App />
    </CsvViewerRuntimeProvider>
  </StrictMode>,
);
