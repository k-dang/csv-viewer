import type { ReactElement } from 'react';
import type { CsvViewerRuntime, CsvViewerRuntimeCapabilities } from '../../shared/csv-viewer-contract';
import { CsvViewerRuntimeProvider } from '../csv-viewer-runtime';

type TestRuntimeOverrides = Partial<Omit<CsvViewerRuntime, 'capabilities'>> & {
  capabilities?: Partial<CsvViewerRuntimeCapabilities>;
};

const desktopLikeCapabilities: CsvViewerRuntimeCapabilities = { recentCsvSources: true };

/**
 * The runtime renderer tests inject. It needs no Electron preload, no browser globals, and no
 * database: a test stubs the operations it exercises, and any other operation throws by name rather
 * than quietly answering.
 */
export function createTestCsvViewerRuntime(overrides: TestRuntimeOverrides = {}): CsvViewerRuntime {
  const { capabilities, ...operations } = overrides;
  const stubbed: Record<string, unknown> = {
    capabilities: { ...desktopLikeCapabilities, ...capabilities },
    // Subscriptions must hand back an unsubscribe function even when a test does not stub them.
    onIntent: () => () => {},
    onComparisonEvent: () => () => {},
    ...operations,
  };

  return new Proxy(stubbed, {
    get(target, key) {
      if (key in target) return target[key as string];
      if (typeof key !== 'string' || key === 'then') return undefined;
      return () => {
        throw new Error(`${key} was called but is not stubbed in this test runtime.`);
      };
    },
  }) as CsvViewerRuntime;
}

/** Renderer components reach their host through the injected runtime, so rendering one needs a provider. */
export function withRuntime(
  element: ReactElement,
  runtime: CsvViewerRuntime = createTestCsvViewerRuntime(),
) {
  return <CsvViewerRuntimeProvider runtime={runtime}>{element}</CsvViewerRuntimeProvider>;
}
