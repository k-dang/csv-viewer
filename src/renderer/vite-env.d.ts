/// <reference types="vite/client" />

import type { CsvViewerApi } from '../shared/ipc';

declare global {
  interface Window {
    csvViewer: CsvViewerApi;
  }
}
