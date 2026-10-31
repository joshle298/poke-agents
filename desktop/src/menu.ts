/**
 * The application menu, as a template main.ts hands to Electron's
 * Menu.buildFromTemplate. Pure (no Electron import), so it is tested without
 * Electron.
 *
 * macOS: the app menu (About, Settings…, Reconnect to Conductor, Hide,
 * Quit), File (Close Window, ⌘W: closing keeps the app in the Dock), Edit (so
 * copy and paste work in the office's text fields), View (Reload, Toggle Full
 * Screen, and Toggle Developer Tools in unpackaged builds only), Window, and
 * Help. Elsewhere File holds Reconnect, Settings and Quit.
 */

import { APP_NAME } from './constants.js';

/** The menu roles this app uses (a subset of Electron's). */
export type MenuRole =
  | 'about'
  | 'close'
  | 'editMenu'
  | 'help'
  | 'hide'
  | 'hideOthers'
  | 'quit'
  | 'reload'
  | 'services'
  | 'toggleDevTools'
  | 'togglefullscreen'
  | 'unhide'
  | 'windowMenu';

/** The slice of Electron's MenuItemConstructorOptions the menu uses. */
export interface MenuItemSpec {
  label?: string;
  role?: MenuRole;
  type?: 'separator';
  accelerator?: string;
  click?: () => void;
  submenu?: MenuItemSpec[];
}

export interface MenuActions {
  /** Re-read the Conductor sign-in and restart polling. */
  reconnectConductor: () => void;
  /** Open the office's Settings. */
  openSettings: () => void;
  /** Open the app's documentation in the browser. */
  openHelp: () => void;
}

const SEPARATOR: MenuItemSpec = { type: 'separator' };

export function buildMenuTemplate(options: {
  isMac: boolean;
  isPackaged: boolean;
  actions: MenuActions;
}): MenuItemSpec[] {
  const { actions } = options;
  const reconnect: MenuItemSpec = {
    label: 'Reconnect to Conductor',
    click: () => actions.reconnectConductor(),
  };
  const settings: MenuItemSpec = {
    label: 'Settings…',
    accelerator: 'CommandOrControl+,',
    click: () => actions.openSettings(),
  };
  const view: MenuItemSpec = {
    label: 'View',
    submenu: [
      { role: 'reload' },
      SEPARATOR,
      { role: 'togglefullscreen' },
      ...(options.isPackaged ? [] : [SEPARATOR, { role: 'toggleDevTools' } as const]),
    ],
  };
  const help: MenuItemSpec = {
    role: 'help',
    submenu: [{ label: `${APP_NAME} Help`, click: () => actions.openHelp() }],
  };
  if (!options.isMac) {
    return [
      { label: 'File', submenu: [reconnect, settings, SEPARATOR, { role: 'quit' }] },
      { role: 'editMenu' },
      view,
      { role: 'windowMenu' },
      help,
    ];
  }
  return [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `About ${APP_NAME}` },
        SEPARATOR,
        settings,
        reconnect,
        SEPARATOR,
        { role: 'services' },
        SEPARATOR,
        { role: 'hide', label: `Hide ${APP_NAME}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        SEPARATOR,
        { role: 'quit', label: `Quit ${APP_NAME}` },
      ],
    },
    { label: 'File', submenu: [{ role: 'close' }] },
    { role: 'editMenu' },
    view,
    { role: 'windowMenu' },
    help,
  ];
}
