import { describe, expect, it, vi } from 'vitest';

import { APP_BROWSERS, openAppWindow, openWithSystem } from '../src/openAppWindow.js';

const URL = 'http://127.0.0.1:41510/?token=3f1c2b8e-0000-4000-8000-000000000000';

/** An exec double that fails for the programs/bundle ids in `missing`. */
function fakeExec(missing: (args: readonly string[]) => boolean = () => false) {
  const calls: Array<[string, readonly string[]]> = [];
  const exec = vi.fn(async (file: string, args: readonly string[]) => {
    calls.push([file, args]);
    if (missing(args)) throw new Error('Unable to find application');
  });
  return { exec, calls };
}

describe('openAppWindow', () => {
  it('macOS: opens the first Chromium browser in app mode, with the URL only in --app', async () => {
    const { exec, calls } = fakeExec();
    const via = await openAppWindow(URL, { platform: 'darwin', exec });
    expect(via).toBe('Google Chrome');
    expect(calls).toEqual([
      ['/usr/bin/open', ['-n', '-b', 'com.google.Chrome', '--args', `--app=${URL}`]],
    ]);
  });

  it('macOS: falls through missing browsers in order', async () => {
    const { exec, calls } = fakeExec(
      (args) => args.includes('com.google.Chrome') || args.includes('com.microsoft.edgemac'),
    );
    const via = await openAppWindow(URL, { platform: 'darwin', exec });
    expect(via).toBe('Brave');
    expect(calls.map(([, args]) => args[2])).toEqual([
      'com.google.Chrome',
      'com.microsoft.edgemac',
      'com.brave.Browser',
    ]);
  });

  it('macOS: tries every candidate, then the default browser', async () => {
    const { exec, calls } = fakeExec((args) => args[0] === '-n');
    const via = await openAppWindow(URL, { platform: 'darwin', exec });
    expect(via).toBe('the default browser');
    expect(calls.map(([, args]) => args[2])).toEqual([
      ...APP_BROWSERS.map((b) => b.bundleId),
      undefined,
    ]);
    expect(calls.at(-1)).toEqual(['/usr/bin/open', [URL]]);
  });

  it('macOS: --browser forces one browser, falling back to the default one', async () => {
    const forced = fakeExec();
    expect(
      await openAppWindow(URL, { platform: 'darwin', exec: forced.exec, browser: 'vivaldi' }),
    ).toBe('Vivaldi');
    expect(forced.calls).toEqual([
      ['/usr/bin/open', ['-n', '-b', 'com.vivaldi.Vivaldi', '--args', `--app=${URL}`]],
    ]);

    const missing = fakeExec((args) => args[0] === '-n');
    expect(
      await openAppWindow(URL, { platform: 'darwin', exec: missing.exec, browser: 'edge' }),
    ).toBe('the default browser');
    expect(missing.calls).toHaveLength(2);
  });

  it('macOS: --browser default skips app mode', async () => {
    const { exec, calls } = fakeExec();
    await openAppWindow(URL, { platform: 'darwin', exec, browser: 'default' });
    expect(calls).toEqual([['/usr/bin/open', [URL]]]);
  });

  it('Linux: xdg-open', async () => {
    const { exec, calls } = fakeExec();
    expect(await openAppWindow(URL, { platform: 'linux', exec })).toBe('the default browser');
    expect(calls).toEqual([['xdg-open', [URL]]]);
  });

  it('rejects when nothing can open it', async () => {
    const { exec } = fakeExec(() => true);
    await expect(openAppWindow(URL, { platform: 'darwin', exec })).rejects.toThrow();
    await expect(openAppWindow(URL, { platform: 'win32', exec })).rejects.toThrow(/win32/);
  });
});

describe('openWithSystem', () => {
  const LINK = 'conductor://workspace?id=w1&session=s1';

  it('hands the link to the registered app, never through a shell', async () => {
    const mac = fakeExec();
    await openWithSystem(LINK, { platform: 'darwin', exec: mac.exec });
    expect(mac.calls).toEqual([['/usr/bin/open', [LINK]]]);

    const linux = fakeExec();
    await openWithSystem(LINK, { platform: 'linux', exec: linux.exec });
    expect(linux.calls).toEqual([['xdg-open', [LINK]]]);
  });

  it('rejects on platforms it cannot open links on, and when the opener fails', async () => {
    await expect(
      openWithSystem(LINK, { platform: 'win32', exec: fakeExec().exec }),
    ).rejects.toThrow();
    await expect(
      openWithSystem(LINK, { platform: 'darwin', exec: fakeExec(() => true).exec }),
    ).rejects.toThrow();
  });
});
