import type { MenuItemConstructorOptions } from 'electron';

type ApplicationMenuOptions = {
  platform: NodeJS.Platform;
  appName: string;
  isDevelopment: boolean;
  onOpenCsv: () => void;
  onReopenCsv: () => void;
  onExportCsv: () => void;
  onCloseTab: () => void;
  onAbout: () => void;
};

export function buildApplicationMenuTemplate({
  platform,
  appName,
  isDevelopment,
  onOpenCsv,
  onReopenCsv,
  onExportCsv,
  onCloseTab,
  onAbout,
}: ApplicationMenuOptions): MenuItemConstructorOptions[] {
  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      {
        label: 'Open CSV...',
        accelerator: 'CmdOrCtrl+O',
        click: onOpenCsv,
      },
      {
        label: 'Reopen CSV',
        accelerator: 'CmdOrCtrl+R',
        click: onReopenCsv,
      },
      {
        label: 'Export CSV...',
        accelerator: 'CmdOrCtrl+Shift+E',
        click: onExportCsv,
      },
      {
        label: 'Close Tab',
        accelerator: 'CmdOrCtrl+W',
        click: onCloseTab,
      },
      { type: 'separator' },
      platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { role: 'reload' },
      ...(isDevelopment ? ([{ role: 'toggleDevTools' }, { type: 'separator' }] as MenuItemConstructorOptions[]) : []),
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
