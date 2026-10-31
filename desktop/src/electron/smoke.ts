import type { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import {
  DESKTOP_BRIDGE_GLOBAL,
  SMOKE_POLL_MS,
  SMOKE_SETTLE_MS,
  SMOKE_TIMEOUT_MS,
} from '../constants.js';

/** What the page shows, read in the renderer (no test hooks needed). */
interface OfficeProbe {
  canvas: boolean;
  sessions: number;
  signIn: boolean;
  empty: boolean;
  /** The preload's bridge reached the page (Reconnect button, app commands). */
  bridge: boolean;
  /** The office said it is read-only: the window's load was not privileged
   *  (no token, or a Host the server does not trust). */
  viewOnly: boolean;
}

const PROBE_SCRIPT = `(() => {
  const canvas = document.querySelector('canvas[data-testid="office-canvas"]');
  const text = document.body ? document.body.innerText : '';
  return {
    canvas: !!canvas && canvas.width > 0 && canvas.height > 0,
    // Party slots (overlays only exist while a character is hovered or selected).
    sessions: document.querySelector('[aria-label="Party"]')?.children.length ?? 0,
    signIn: text.includes('Sign in to Conductor'),
    empty: text.includes('No sessions in scope'),
    bridge: typeof window[${JSON.stringify(DESKTOP_BRIDGE_GLOBAL)}]?.reconnectConductor === 'function',
    viewOnly: text.includes('View only'),
  };
})()`;

const CLICK_RECONNECT_SCRIPT = `(() => {
  const button = [...document.querySelectorAll('button')].find(
    (el) => el.textContent && el.textContent.trim() === 'Reconnect',
  );
  if (!button) return false;
  button.click();
  return true;
})()`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface SmokeOptions {
  /** Also click the sign-in card's Reconnect button, if the card shows, and
   *  wait for the app's answer. Resolves with how the reconnect went (null:
   *  no answer in time). Called before the click. */
  reconnect?: () => Promise<string | null>;
}

/**
 * The smoke run: wait for the office canvas and sessions (or the sign-in
 * steps; an empty office counts once the wait runs out), give sprites time
 * to arrive, capture the window to `outPath`, check the preload bridge and
 * that the office is privileged (not "View only"), and report. It never asks Conductor to act: the only click it can make is the
 * opt-in Reconnect on the sign-in card, which shows only when there is no
 * Conductor sign-in. Resolves true when the office rendered.
 */
export async function runSmoke(
  window: BrowserWindow,
  outPath: string,
  options: SmokeOptions = {},
): Promise<boolean> {
  const deadline = Date.now() + SMOKE_TIMEOUT_MS;
  let probe: OfficeProbe | null = null;
  while (Date.now() < deadline) {
    try {
      probe = (await window.webContents.executeJavaScript(PROBE_SCRIPT)) as OfficeProbe;
    } catch {
      probe = null; // still loading
    }
    // "No sessions in scope" also shows while the first sessions are still
    // being onboarded, so keep waiting for them until the deadline.
    if (probe?.canvas && (probe.sessions > 0 || probe.signIn)) break;
    await sleep(SMOKE_POLL_MS);
  }
  if (!probe?.canvas) {
    console.error('[Poke Agents] smoke: the office never rendered');
    return false;
  }
  await sleep(SMOKE_SETTLE_MS);
  probe = (await window.webContents.executeJavaScript(PROBE_SCRIPT)) as OfficeProbe;
  const image = await window.webContents.capturePage();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, image.toPNG());
  const size = image.getSize();
  const state = probe.signIn ? 'sign-in needed' : probe.empty ? 'no sessions in scope' : 'office';
  console.log(
    `[Poke Agents] smoke: rendered ${state} with ${probe.sessions} session(s); captured ${size.width}x${size.height} to ${outPath}`,
  );
  if (!probe.bridge) {
    console.error('[Poke Agents] smoke: the preload bridge is missing from the office page');
    return false;
  }
  console.log('[Poke Agents] smoke: preload bridge present');
  if (probe.viewOnly) {
    console.error('[Poke Agents] smoke: the office loaded view-only, without the token');
    return false;
  }
  console.log('[Poke Agents] smoke: the office loaded privileged (tokened)');
  if (options.reconnect && probe.signIn) {
    const answer = options.reconnect();
    const clicked = (await window.webContents.executeJavaScript(CLICK_RECONNECT_SCRIPT)) as boolean;
    if (!clicked) {
      console.error('[Poke Agents] smoke: the sign-in card has no Reconnect button');
      return false;
    }
    const outcome = await answer;
    console.log(
      `[Poke Agents] smoke: clicked Reconnect; the app answered: ${outcome ?? 'nothing'}`,
    );
    if (outcome === null) return false;
  }
  return true;
}
