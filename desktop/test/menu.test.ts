import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildMenuTemplate, type MenuItemSpec } from '../src/menu.js';

function build(isMac: boolean, isPackaged = true) {
  const calls: string[] = [];
  const template = buildMenuTemplate({
    isMac,
    isPackaged,
    actions: {
      reconnectConductor: () => calls.push('reconnect'),
      openSettings: () => calls.push('settings'),
      openHelp: () => calls.push('help'),
    },
  });
  return { template, calls };
}

/** Every item in the menu, depth first. */
function items(template: MenuItemSpec[]): MenuItemSpec[] {
  return template.flatMap((item) => [item, ...items(item.submenu ?? [])]);
}

const find = (template: MenuItemSpec[], test: (item: MenuItemSpec) => boolean) =>
  items(template).find(test);

describe('buildMenuTemplate on macOS', () => {
  it('has a File menu whose Close Window (⌘W) closes the window, not the app', () => {
    const { template } = build(true);
    const file = template.find((menu) => menu.label === 'File');
    assert.deepEqual(file?.submenu, [{ role: 'close' }]);
    // The Window menu role holds only Minimize, Zoom and Bring All to Front.
    assert.ok(template.some((menu) => menu.role === 'windowMenu'));
  });

  it('puts About, Settings… (⌘,), Reconnect and Quit in the app menu', () => {
    const { template, calls } = build(true);
    const appMenu = template[0];
    assert.equal(appMenu.label, 'Poke Agents');
    const labels = (appMenu.submenu ?? []).map((item) => item.label ?? item.role ?? '-');
    assert.deepEqual(labels.slice(0, 4), [
      'About Poke Agents',
      '-',
      'Settings…',
      'Reconnect to Conductor',
    ]);
    assert.equal(labels.at(-1), 'Quit Poke Agents');
    const settings = appMenu.submenu?.find((item) => item.label === 'Settings…');
    assert.equal(settings?.accelerator, 'CommandOrControl+,');
    settings?.click?.();
    appMenu.submenu?.find((item) => item.label === 'Reconnect to Conductor')?.click?.();
    assert.deepEqual(calls, ['settings', 'reconnect']);
  });

  it('links Help to the documentation', () => {
    const { template, calls } = build(true);
    const help = template.find((menu) => menu.role === 'help');
    assert.equal(help?.submenu?.[0]?.label, 'Poke Agents Help');
    help?.submenu?.[0]?.click?.();
    assert.deepEqual(calls, ['help']);
  });

  it('offers Developer Tools only in an unpackaged build', () => {
    const isDevTools = (item: MenuItemSpec) => item.role === 'toggleDevTools';
    assert.equal(find(build(true, true).template, isDevTools), undefined);
    assert.ok(find(build(true, false).template, isDevTools));
    assert.ok(find(build(true, true).template, (item) => item.role === 'reload'));
    assert.ok(find(build(true, true).template, (item) => item.role === 'togglefullscreen'));
  });
});

describe('buildMenuTemplate elsewhere', () => {
  it('keeps Reconnect, Settings and Quit in File', () => {
    const { template } = build(false);
    const file = template[0];
    assert.equal(file.label, 'File');
    assert.deepEqual(
      (file.submenu ?? []).map((item) => item.label ?? item.role ?? '-'),
      ['Reconnect to Conductor', 'Settings…', '-', 'quit'],
    );
  });
});
