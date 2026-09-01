import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../renderer/App';
import { CsvViewerProvider } from '../renderer/csv-viewer';
import '../renderer/styles.css';
import { pickPortableCsvSource } from './portable-csv-picker';
import { startWebCsvViewer } from './web-composition';
import { createWebDuckDb } from './web-duckdb';
import { WebStartupState } from './web-startup-state';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('CSV Viewer Web root element was not found.');
const root = createRoot(rootElement);

root.render(<WebStartupState status="checking" />);

void startWebCsvViewer(createWebDuckDb(), pickPortableCsvSource).then((started) => {
  if (started.status === 'unsupported') {
    root.render(<WebStartupState status="unsupported" />);
    return;
  }
  root.render(
    <StrictMode>
      <CsvViewerProvider viewer={started.viewer}>
        <App />
      </CsvViewerProvider>
    </StrictMode>,
  );
});
