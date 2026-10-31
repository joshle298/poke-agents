import type { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { SMOKE_POLL_MS, SMOKE_SETTLE_MS, SMOKE_TIMEOUT_MS } from '../constants.js';

/** What the page shows, read in the renderer (no test hooks needed). */
interface OfficeProbe {
  canvas: boolean;
  sessions: number;
  signIn: boolean;
  empty: boolean;
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
  };
})()`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The smoke run: wait for the office canvas and sessions (or the sign-in
 * steps; an empty office counts once the wait runs out), give sprites time
 * to arrive, capture the window to
 * `outPath`, and report. Only reads: it clicks nothing, so it never asks
 * Conductor to act. Resolves true when the office rendered.
 */
export async function runSmoke(window: BrowserWindow, outPath: string): Promise<boolean> {
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
  return true;
}
