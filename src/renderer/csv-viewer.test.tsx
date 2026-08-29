import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CsvViewerProvider, useCsvViewer } from './csv-viewer';
import { createTestCsvViewer } from './testing/test-csv-viewer';

function Capabilities() {
  return <p>{String(useCsvViewer().capabilities.recentCsvSources)}</p>;
}

describe('CsvViewer seam', () => {
  it('gives a component the injected CsvViewer', () => {
    const markup = renderToStaticMarkup(
      <CsvViewerProvider viewer={createTestCsvViewer({ capabilities: { recentCsvSources: false } })}>
        <Capabilities />
      </CsvViewerProvider>,
    );

    expect(markup).toBe('<p>false</p>');
  });

  it('refuses to run without an injected CsvViewer rather than reaching for a global', () => {
    expect(() => renderToStaticMarkup(<Capabilities />)).toThrow('CSV Viewer was not provided.');
  });
});
