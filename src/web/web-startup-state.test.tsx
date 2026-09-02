import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WebStartupState } from './web-startup-state';

describe('WebStartupState', () => {
  it('gates file selection while the browser capability check runs', () => {
    const markup = renderToStaticMarkup(<WebStartupState status="checking" />);

    expect(markup).toContain('Checking browser support');
    expect(markup).not.toContain('Open CSV');
  });

  it('lists supported browsers and the desktop fallback after a failed check', () => {
    const markup = renderToStaticMarkup(<WebStartupState status="unsupported" />);

    expect(markup).toContain('Chrome, Edge, Firefox, and Safari');
    expect(markup).toContain('CSV Viewer Desktop');
    expect(markup).not.toContain('Open CSV');
  });
});
