import { createContext, useContext, type ReactNode } from 'react';
import type { CsvViewer } from '../shared/csv-viewer-contract';

const CsvViewerContext = createContext<CsvViewer | null>(null);

/** Injects CsvViewer at the composition root so components depend only on the product contract. */
export function CsvViewerProvider({ viewer, children }: { viewer: CsvViewer; children: ReactNode }) {
  return <CsvViewerContext.Provider value={viewer}>{children}</CsvViewerContext.Provider>;
}

export function useCsvViewer(): CsvViewer {
  const viewer = useContext(CsvViewerContext);
  if (!viewer) throw new Error('CSV Viewer was not provided.');
  return viewer;
}
