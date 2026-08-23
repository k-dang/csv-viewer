import { createContext, useContext, type ReactNode } from 'react';
import type { CsvViewerRuntime } from '../shared/csv-viewer-contract';

const CsvViewerRuntimeContext = createContext<CsvViewerRuntime | null>(null);

/** Injects the host runtime at the composition root; React below this point sees only the contract. */
export function CsvViewerRuntimeProvider({
  runtime,
  children,
}: {
  runtime: CsvViewerRuntime;
  children: ReactNode;
}) {
  return (
    <CsvViewerRuntimeContext.Provider value={runtime}>{children}</CsvViewerRuntimeContext.Provider>
  );
}

export function useCsvViewerRuntime(): CsvViewerRuntime {
  const runtime = useContext(CsvViewerRuntimeContext);
  if (!runtime) throw new Error('CSV Viewer runtime was not provided.');
  return runtime;
}
