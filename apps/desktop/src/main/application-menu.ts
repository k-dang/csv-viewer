import type { MenuItemConstructorOptions } from 'electron';
import type { CsvViewerIntent } from '@csv-viewer/workspace/csv-viewer';

type ApplicationMenuOptions = {
  platform: NodeJS.Platform;
  appName: string;
  isDevelopment: boolean;
  /** Native menu commands leave this module as domain intents; no command names travel onward. */
  onIntent: (intent: CsvViewerIntent) => void;
  onAbout: () => void;
};

export function buildApplicationMenuTemplate({
  platform,
  appName,
  isDevelopment,
  onIntent,
  onAbout,
}: ApplicationMenuOptions): MenuItemConstructorOptions[] {
  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      {
        label: 'Open CSV...',
        accelerator: 'CmdOrCtrl+O',
        click: () => onIntent('open-csv'),
      },
      {
        label: 'Reopen CSV',
        accelerator: 'CmdOrCtrl+R',
        click: () => onIntent('reopen-csv'),
      },
      {
        label: 'Export CSV...',
        accelerator: 'CmdOrCtrl+Shift+E',
        click: () => onIntent('export-csv'),
      },
      {
        label: 'Close Tab',
        accelerator: 'CmdOrCtrl+W',
        click: () => onIntent('close-tab'),
      },
      { type: 'separator' },
      platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
    ],
  };

  const developmentItems: MenuItemConstructorOptions[] = [];
  if (isDevelopment) developmentItems.push({ role: 'toggleDevTools' }, { type: 'separator' });

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { role: 'reload' },
      ...developmentItems,
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    role: 'editMenu',
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: [{ role: 'minimize' }, { role: 'close' }],
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: 'Help',
    submenu: [
      {
        label: 'About CSV Viewer',
        click: onAbout,
      },
    ],
  };

  return platform === 'darwin'
    ? [
        {
          label: appName,
          submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }],
        },
        fileMenu,
        editMenu,
        viewMenu,
        windowMenu,
        helpMenu,
      ]
    : [fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
}
