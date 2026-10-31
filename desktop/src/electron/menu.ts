import type { MenuItemConstructorOptions } from 'electron';

import { APP_NAME } from '../constants.js';

export interface MenuActions {
  /** Re-read the Conductor sign-in and restart polling. */
  reconnectConductor: () => void;
}

/**
 * The application menu. macOS: the app menu (About, Reconnect to Conductor,
 * Hide, Quit), Edit (so copy and paste work in the office's text fields),
 * View (Reload, Toggle Full Screen, and Toggle Developer Tools in unpackaged
 * builds only) and Window. Elsewhere a File menu holds Reconnect and Quit.
 */
export function buildMenuTemplate(options: {
  isMac: boolean;
  isPackaged: boolean;
  actions: MenuActions;
}): MenuItemConstructorOptions[] {
  const reconnect: MenuItemConstructorOptions = {
    label: 'Reconnect to Conductor',
    click: () => options.actions.reconnectConductor(),
  };
  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      ...(options.isPackaged
        ? []
        : [{ type: 'separator' } as const, { role: 'toggleDevTools' } as const]),
    ],
  };
  if (!options.isMac) {
    return [
      { label: 'File', submenu: [reconnect, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' },
      view,
      { role: 'windowMenu' },
    ];
  }
  return [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `About ${APP_NAME}` },
        { type: 'separator' },
        reconnect,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${APP_NAME}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${APP_NAME}` },
      ],
    },
    { role: 'editMenu' },
    view,
    { role: 'windowMenu' },
  ];
}
