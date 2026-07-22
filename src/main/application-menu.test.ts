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
});
