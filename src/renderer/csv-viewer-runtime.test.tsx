import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CsvViewerRuntimeProvider, useCsvViewerRuntime } from './csv-viewer-runtime';
import { createTestCsvViewerRuntime } from './testing/test-csv-viewer-runtime';

function Capabilities() {
  return <p>{String(useCsvViewerRuntime().capabilities.recentCsvSources)}</p>;
}

describe('CsvViewerRuntime seam', () => {
  it('gives a component the injected runtime', () => {
    const markup = renderToStaticMarkup(
      <CsvViewerRuntimeProvider
        runtime={createTestCsvViewerRuntime({ capabilities: { recentCsvSources: false } })}
      >
        <Capabilities />
      </CsvViewerRuntimeProvider>,
    );

    expect(markup).toBe('<p>false</p>');
  });

  it('refuses to run without an injected runtime rather than reaching for a global', () => {
    expect(() => renderToStaticMarkup(<Capabilities />)).toThrow(
      'CSV Viewer runtime was not provided.',
    );
  });
});
