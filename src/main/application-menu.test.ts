import { describe, expect, it, vi } from 'vitest';
import { buildApplicationMenuTemplate } from './application-menu';

describe('buildApplicationMenuTemplate', () => {
  it('includes the native Edit menu in the macOS application menu', () => {
    const template = buildApplicationMenuTemplate({
      platform: 'darwin',
      appName: 'CSV Viewer',
      isDevelopment: false,
      onOpenCsv: vi.fn(),
      onReopenCsv: vi.fn(),
      onExportCsv: vi.fn(),
      onCloseTab: vi.fn(),
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

  it('translates the native Export CSV command into an application intent', () => {
    const onExportCsv = vi.fn();
    const template = buildApplicationMenuTemplate({
      platform: 'win32',
      appName: 'CSV Viewer',
      isDevelopment: false,
      onOpenCsv: vi.fn(),
      onReopenCsv: vi.fn(),
      onExportCsv,
      onCloseTab: vi.fn(),
      onAbout: vi.fn(),
    });
    const fileMenu = template.find((item) => item.label === 'File');
    const exportItem = Array.isArray(fileMenu?.submenu)
      ? fileMenu.submenu.find((item) => item.label === 'Export CSV...')
      : undefined;

    expect(exportItem).toBeDefined();
    if (typeof exportItem?.click === 'function') {
      exportItem.click({} as never, undefined, {} as never);
    }
    expect(onExportCsv).toHaveBeenCalledOnce();
  });
});
