import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WebSocketRoute } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import type { TestHooksWindow } from '../../helpers/editor';
import { sendHookEvent, sessionStartStartup } from '../../helpers/hooks';
import { buildSeedLayout } from '../../helpers/layout-seed';
import {
  closeAgentFromOverlay,
  expectOverlayCount,
  expectOverlayVisible,
  readAgentOverlayIds,
} from '../../helpers/office';
import { openSettingsModal, setSettings } from '../../helpers/webview';

// The DebugView diagnostics block polls every 2s (see DebugView.tsx); allow a
// few polling rounds plus IPC/render slop.
const DIAGNOSTICS_POLL_TIMEOUT_MS = 15_000;
// onReloadAssets does its filesystem work after the externalAssetDirectoriesUpdated
// reply, so the re-broadcast lands slightly later than the dir-list update.
const ASSET_RELOAD_TIMEOUT_MS = 15_000;
// WebSocketTransport reconnects with capped exponential backoff (up to 4s);
// allow a couple of retry cycles for the state to settle both ways.
const CONNECTION_STATE_TIMEOUT_MS = 15_000;

test.describe('Standalone / UI', () => {
  test('closeAgent despawns the character @area:standalone', async ({ page, standalone }) => {
    await setSettings(page, {
      alwaysShowLabels: true,
      hooksEnabled: true,
      watchAllSessions: true,
      debugView: false,
    });
    await standalone.drainMessages();

    const sessionId = 'standalone-close-agent-session';
    const filePath = path.join(standalone.workspaceDir, 'close-agent.ts');

    await sendHookEvent(
      standalone.hookServerConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir),
    );
    await sendHookEvent(standalone.hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: filePath },
    });

    await expectOverlayCount(page, 1);
    await expectOverlayVisible(page, 'Reading close-agent.ts');
    await standalone.drainMessages();

    await closeAgentFromOverlay(page, { text: 'Reading close-agent.ts' });

    await expectOverlayCount(page, 0);
    const messages = await standalone.drainMessages();
    expect(messages.some((message) => message.type === 'agentClosed')).toBe(true);
  });

  test('Debug View renders JSONL diagnostics in standalone @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, {
      debugView: true,
      hooksEnabled: true,
      watchAllSessions: true,
      alwaysShowLabels: true,
    });

    const sessionId = 'standalone-debug-view-session';
    const filePath = path.join(standalone.workspaceDir, 'debug-view.ts');

    await sendHookEvent(
      standalone.hookServerConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir),
    );
    await sendHookEvent(standalone.hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: filePath },
    });

    // Presence of the diagnostics block (either branch) is the proof that the
    // agentDiagnostics reply reached the webview via transport.onMessage; do
    // not assert a specific jsonlExists branch (a hook-only session may or may
    // not have a materialized transcript file).
    await expect(page.getByText(/JSONL (connected|not found)/)).toBeVisible({
      timeout: DIAGNOSTICS_POLL_TIMEOUT_MS,
    });
  });

  test('adding an external asset directory triggers a live asset reload @area:standalone', async ({
    page,
    standalone,
  }) => {
    const modal = await openSettingsModal(page);
    await standalone.drainMessages();

    await modal
      .locator('input[placeholder="Absolute asset directory path"]')
      .fill(standalone.workspaceDir);
    await modal.locator('button', { hasText: 'Add' }).click();

    // getByTitle matches the title attribute literally; a raw CSS
    // [title="..."] selector would mis-parse the backslashes in a Windows path
    // as CSS escapes and never match its own title.
    await expect(modal.getByTitle(standalone.workspaceDir, { exact: true })).toBeVisible();

    // Light depth: prove the onReloadAssets re-broadcast fired, not a
    // character-count delta (no fixture PNGs staged in workspaceDir).
    await expect
      .poll(
        async () => {
          const messages = await standalone.drainMessages();
          return messages.some((message) => message.type === 'characterSpritesLoaded');
        },
        { timeout: ASSET_RELOAD_TIMEOUT_MS },
      )
      .toBe(true);
  });

  test('browser Export Layout downloads the layout file @area:standalone', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();
    const modal = await openSettingsModal(page);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      modal.locator('button', { hasText: 'Export Layout' }).click(),
    ]);

    expect(download.suggestedFilename()).toBe('pixel-agents-layout.json');
  });

  test('browser Import Layout applies the chosen file @area:standalone', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    const uniqueLabel = `Imported Area ${Date.now().toString()}`;
    const layout = buildSeedLayout({
      areas: [{ label: uniqueLabel, color: '#4287f5' }],
      areaTiles: [{ col: 1, row: 1, label: uniqueLabel }],
    });
    const tmpFile = path.join(os.tmpdir(), `pixel-agents-import-${Date.now().toString()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(layout));

    try {
      const modal = await openSettingsModal(page);
      // Set the hidden import input directly rather than clicking "Import
      // Layout" (which would open the OS file dialog Playwright can't drive).
      await page.setInputFiles('input[type="file"]', tmpFile);
      await expect(modal).toBeHidden();

      // saveLayout is client→server and unrecorded by drainMessages (Seam A),
      // so assert the applied OfficeState instead of the wire message.
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as TestHooksWindow).__pixelAgentsTestHooks?.getAreas?.() ?? [],
          ),
        )
        .toContainEqual({ label: uniqueLabel, color: '#4287f5' });
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });

  test('ConnectionIndicator appears when the WebSocket connection drops @area:standalone', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    // Settle wait before the negative assertion (office.ts wait-strategy
    // convention): give the runtime a chance to render the indicator wrongly
    // before checking absence.
    await page.waitForTimeout(500);
    await expect(page.getByText(/Reconnecting|Disconnected/)).toHaveCount(0);

    // Fallback for assumption A1: `page.context().setOffline(true)` does not
    // reliably close an already-open WebSocket on this Chromium build (verified
    // empirically — the indicator never appeared). Stopping the real host
    // process closes the socket from the server side instead.
    await standalone.stopHost();
    await expect(page.getByText(/Reconnecting|Disconnected/)).toBeVisible({
      timeout: CONNECTION_STATE_TIMEOUT_MS,
    });

    await standalone.startHost();
    await expect(page.getByText(/Reconnecting|Disconnected/)).toHaveCount(0, {
      timeout: CONNECTION_STATE_TIMEOUT_MS,
    });
  });

  test('the toolbar holds the top-right corner and the connection pill stays clear of it @area:standalone', async ({
    page,
    standalone,
  }) => {
    const toolbar = page.locator('.pixel-panel', {
      has: page.getByRole('button', { name: 'Settings', exact: true }),
    });
    const indicator = page.getByText(/Reconnecting|Disconnected/);
    await expect(toolbar).toBeVisible();

    // The connection pill is centred at the top: beside the toolbar on a wide
    // window, under it on a narrow one (800 px still gets the desktop shell).
    await standalone.stopHost();
    await expect(indicator).toBeVisible({ timeout: CONNECTION_STATE_TIMEOUT_MS });
    for (const size of [
      { width: 1280, height: 800 },
      { width: 800, height: 800 },
    ]) {
      await page.setViewportSize(size);
      // An empty office has no party bar: the toolbar's corner is the window's.
      await expect
        .poll(async () => {
          const box = await toolbar.boundingBox();
          return box && box.y <= 16 && box.x + box.width >= size.width - 16;
        })
        .toBe(true);
      const bar = (await toolbar.boundingBox())!;
      const pill = (await indicator.boundingBox())!;
      const overlapX = Math.min(bar.x + bar.width, pill.x + pill.width) - Math.max(bar.x, pill.x);
      const overlapY = Math.min(bar.y + bar.height, pill.y + pill.height) - Math.max(bar.y, pill.y);
      expect(overlapX <= 0 || overlapY <= 0).toBe(true);
    }
    await standalone.startHost();
    await expect(indicator).toHaveCount(0, { timeout: CONNECTION_STATE_TIMEOUT_MS });
  });
});

/** What the desktop app's preload exposes (webview-ui/src/desktopApp.ts),
 *  faked so the test can send its commands. */
interface FakeDesktopWindow {
  pokeAgentsDesktop?: {
    reconnectConductor: () => void;
    onCommand: (listener: (command: unknown) => void) => () => void;
  };
  __sendDesktopCommand?: (command: unknown) => void;
}

test.describe('Standalone / layout editor beside the Pokédex drawer', () => {
  test.use({ standaloneOptions: { viewport: { width: 860, height: 900 } } });

  test('the layout palette stays left of the Pokédex drawer, its tools reachable @area:standalone', async ({
    page,
    standalone,
  }) => {
    // Only Conductor agents open a Pokédex on click; the Mac app's
    // notification click opens any session's. Fake that bridge (read once,
    // as the page loads) and send the click.
    await page.addInitScript(() => {
      const w = window as unknown as FakeDesktopWindow;
      w.pokeAgentsDesktop = {
        reconnectConductor: () => {},
        onCommand: (listener) => {
          w.__sendDesktopCommand = listener;
          return () => {};
        },
      };
    });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });
    await setSettings(page, {
      alwaysShowLabels: true,
      hooksEnabled: true,
      watchAllSessions: true,
      debugView: false,
    });

    const sessionId = 'standalone-palette-drawer-session';
    await sendHookEvent(
      standalone.hookServerConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir),
    );
    await sendHookEvent(standalone.hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: path.join(standalone.workspaceDir, 'drawer.ts') },
    });
    await expectOverlayCount(page, 1);
    const [agentId] = await readAgentOverlayIds(page);
    await page.evaluate((id) => {
      (window as unknown as FakeDesktopWindow).__sendDesktopCommand?.({
        type: 'openSession',
        agentId: id,
      });
    }, agentId);

    // 860 px is under the docking width: the Pokédex is a drawer over the
    // office's right edge.
    const drawer = page.getByRole('complementary', { name: 'Pokédex' });
    await expect(drawer).toBeVisible();
    await page.getByRole('button', { name: 'Layout', exact: true }).click();
    const palette = page.locator('.pixel-panel', {
      has: page.getByRole('button', { name: 'Furniture', exact: true }),
    });
    await expect(palette).toBeVisible();

    const drawerBox = (await drawer.boundingBox())!;
    const paletteBox = (await palette.boundingBox())!;
    expect(paletteBox.x + paletteBox.width).toBeLessThanOrEqual(drawerBox.x);
    // Its tool row wraps instead: the last tool is clickable, not under the
    // drawer.
    await page.getByRole('button', { name: 'Templates', exact: true }).click();
    await expect(page.getByTestId('templates-panel')).toBeVisible();
  });
});

test.describe('Standalone / message bar under the office', () => {
  test.use({ standaloneOptions: { viewport: { width: 1100, height: 800 } } });

  test('the battle log reads in a bar under the map, clear of the palette, and closes when off @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { hooksEnabled: true, watchAllSessions: true, debugView: false });
    const bar = page.getByTestId('message-bar');
    const canvas = page.getByTestId('office-canvas');
    const bottomOf = async (locator: typeof bar) => {
      const box = (await locator.boundingBox())!;
      return box.y + box.height;
    };

    // The bar runs along the window's bottom edge, under the canvas: the map
    // ends where the bar starts.
    await expect
      .poll(async () => {
        const barBox = await bar.boundingBox();
        return barBox !== null && barBox.height > 0 && barBox.y + barBox.height;
      })
      .toBe(800);
    expect(await bottomOf(canvas)).toBeLessThanOrEqual((await bar.boundingBox())!.y);

    // A tool start writes "… used Read!" in the bar.
    const sessionId = 'standalone-message-bar-session';
    await sendHookEvent(
      standalone.hookServerConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir),
    );
    await sendHookEvent(standalone.hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: path.join(standalone.workspaceDir, 'bar.ts') },
    });
    // Up for BATTLE_LOG_VISIBLE_MS (4 s): typed into the box, and read out by
    // the bar's live region.
    await expect(bar.locator('.message-bar-line', { hasText: 'used Read!' })).toBeVisible();
    await expect(bar.getByRole('status').filter({ hasText: 'used Read!' })).toHaveCount(1);

    // The layout editor's palette stands on top of the bar.
    await page.getByRole('button', { name: 'Layout', exact: true }).click();
    const palette = page.locator('.pixel-panel', {
      has: page.getByRole('button', { name: 'Furniture', exact: true }),
    });
    await expect(palette).toBeVisible();
    expect(await bottomOf(palette)).toBeLessThanOrEqual((await bar.boundingBox())!.y);
    await page.getByRole('button', { name: 'Layout', exact: true }).click();
    await expect(palette).toBeHidden();

    // Battle Log off, in an office no action outcome can reach (no
    // Conductor): the bar closes and the map takes the room back.
    await setSettings(page, { battleLog: false });
    await expect.poll(async () => (await bar.boundingBox())?.height ?? 0).toBe(0);
    await expect.poll(() => bottomOf(canvas)).toBe(800);
  });

  test('action outcomes are chips in the bar: an error whole, never hidden by a success, the map unmoved @area:standalone', async ({
    page,
    // Launches the office (and opens it in `page`).
    standalone: _standalone,
  }) => {
    // Outcomes come from Conductor actions, which this office has none of:
    // play them in over the page's own socket.
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket(/\/ws/, (ws) => {
      ws.connectToServer();
      sockets.push(ws);
    });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });
    const send = (message: Record<string, unknown>) =>
      sockets.at(-1)!.send(JSON.stringify(message));
    const bar = page.getByTestId('message-bar');
    const canvas = page.getByTestId('office-canvas');
    await expect.poll(async () => (await bar.boundingBox())?.height ?? 0).toBeGreaterThan(0);
    const canvasBefore = await canvas.boundingBox();

    const reason =
      'Conductor refused the request because the session is already archived on another device';
    const failure = `Couldn't stop the session: ${reason}`;
    send({ type: 'conductorActionResult', action: 'stopSession', ok: false, message: reason });
    await expect(bar.getByRole('alert')).toHaveText(failure);
    const chips = bar.getByTestId('message-bar-chip');
    const errorChip = chips.filter({ hasText: reason });
    await expect(errorChip).toBeVisible();
    // Inside the bar, its whole reason showing (wrapped, not cut).
    const barBox = (await bar.boundingBox())!;
    const chipBox = (await errorChip.boundingBox())!;
    expect(chipBox.y).toBeGreaterThanOrEqual(barBox.y);
    expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(barBox.y + barBox.height);
    const clipped = await errorChip.evaluate((chip) =>
      Array.from(chip.querySelectorAll('span')).some(
        (span) => span.scrollHeight > span.clientHeight || span.scrollWidth > span.clientWidth,
      ),
    );
    expect(clipped).toBe(false);
    // The bar keeps its height for the battle log: the map never moves.
    expect(await canvas.boundingBox()).toEqual(canvasBefore);

    // A newer success is read out, but never hides the error still up.
    send({ type: 'conductorActionResult', action: 'sendSessionMessage', ok: true });
    await expect(bar.getByRole('status').filter({ hasText: 'Message sent' })).toHaveCount(1);
    // Checked at once, not retried: a retry could outlast the success.
    expect(await errorChip.isVisible()).toBe(true);

    // Each × is named after its toast; dismissing the error shows the success.
    await bar.getByRole('button', { name: `Dismiss: ${failure}` }).click();
    await expect(errorChip).toHaveCount(0);
    await expect(chips.filter({ hasText: 'Message sent' })).toBeVisible();
    expect(await canvas.boundingBox()).toEqual(canvasBefore);
  });
});
