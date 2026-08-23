import { describe, expect, it, vi } from 'vitest';
import type { CsvViewerIntent } from '../shared/csv-viewer-contract';
import { buildApplicationMenuTemplate } from './application-menu';

function clickFileMenuItem(label: string): CsvViewerIntent[] {
  const intents: CsvViewerIntent[] = [];
  const template = buildApplicationMenuTemplate({
    platform: 'win32',
    appName: 'CSV Viewer',
    isDevelopment: false,
    onIntent: (intent) => intents.push(intent),
    onAbout: vi.fn(),
  });
  const fileMenu = template.find((item) => item.label === 'File');
  const menuItem = Array.isArray(fileMenu?.submenu)
    ? fileMenu.submenu.find((item) => item.label === label)
    : undefined;

  expect(menuItem).toBeDefined();
  if (typeof menuItem?.click === 'function') {
    menuItem.click({} as never, undefined, {} as never);
  }
  return intents;
}

describe('buildApplicationMenuTemplate', () => {
  it('includes the native Edit menu in the macOS application menu', () => {
    const template = buildApplicationMenuTemplate({
      platform: 'darwin',
      appName: 'CSV Viewer',
      isDevelopment: false,
      onIntent: vi.fn(),
      onAbout: vi.fn(),
    });

    expect(template.map((item) => item.role ?? item.label)).toEqual([
      'CSV Viewer',
      'File',
      'editMenu',
      'View',
      'Window',
      'Help',
    ]);
  });

  it.each([
    ['Open CSV...', 'open-csv'],
    ['Reopen CSV', 'reopen-csv'],
    ['Export CSV...', 'export-csv'],
    ['Close Tab', 'close-tab'],
  ] as const)('translates the native %s command into the %s intent', (label, intent) => {
    expect(clickFileMenuItem(label)).toEqual([intent]);
  });
});
