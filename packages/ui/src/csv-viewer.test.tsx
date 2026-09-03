import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useCsvViewer } from './csv-viewer';

function Capabilities() {
  return <p>{String(useCsvViewer().capabilities.recentCsvSources)}</p>;
}

describe('CsvViewer seam', () => {
  it('refuses to run without an injected CsvViewer rather than reaching for a global', () => {
    expect(() => renderToStaticMarkup(<Capabilities />)).toThrow('CSV Viewer was not provided.');
  });
});
