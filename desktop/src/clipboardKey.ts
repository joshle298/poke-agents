/**
 * What the Mac app hands the office from the clipboard: a Conductor API key,
 * or nothing. Pure (no Electron), so main's whole answer is tested.
 *
 * Main reads the clipboard only when the office page in the office window
 * asks while the window is focused, and on two occasions only:
 * - `paste`: the Connect card's Paste click. The preload sends it only during
 *   a user's click (transient user activation); main answers with text shaped
 *   like a key (CONDUCTOR_KEY_PATTERN).
 * - `suggest`: the first focus after "Get an API key". Main answers only when
 *   it just sent Conductor's API keys page to the browser (`arm`), once per
 *   opening, and only with text shaped like a Conductor key
 *   (CONDUCTOR_KEY_SUGGEST_PATTERN, narrower: other services' tokens are not
 *   offered). The card shows it masked and fills the field; nothing is sent
 *   until the user clicks Connect.
 * No other clipboard content ever reaches the page, and nothing is logged.
 */

import { CONDUCTOR_KEY_PATTERN } from '../../core/src/constants.js';
import { API_KEYS_PAGE_URL } from '../../server/src/providers/stream/conductor/constants.js';
import { CLIPBOARD_SUGGESTION_WINDOW_MS, CONDUCTOR_KEY_SUGGEST_PATTERN } from './constants.js';

/** Paste: the clipboard text when, trimmed, it has a Conductor API key's shape. */
export function clipboardKey(text: string): string | null {
  const key = text.trim();
  return CONDUCTOR_KEY_PATTERN.test(key) ? key : null;
}

/** The suggestion: the clipboard text when, trimmed, it looks like a
 *  Conductor key specifically. */
export function clipboardKeySuggestion(text: string): string | null {
  const key = text.trim();
  return CONDUCTOR_KEY_SUGGEST_PATTERN.test(key) ? key : null;
}

/** Whether a link the office window sends to the browser is Conductor's API
 *  keys page ("Get an API key"). */
export function isApiKeysPage(url: string): boolean {
  try {
    const target = new URL(url);
    const page = new URL(API_KEYS_PAGE_URL);
    return target.origin === page.origin && target.pathname.replace(/\/+$/, '') === page.pathname;
  } catch {
    return false;
  }
}

/** One request from the office window, as main sees it. */
export interface ClipboardKeyRequest {
  /** From the renderer, so unchecked: `paste` or `suggest`. */
  purpose: unknown;
  /** The office page in the office window sent it (isOfficeSender). */
  fromOffice: boolean;
  /** The office window has focus. */
  focused: boolean;
}

/** Main's answer to the office's clipboard requests. */
export class ClipboardKeyGate {
  private armedUntil = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** The office window just sent the API keys page to the browser: the next
   *  `suggest` within CLIPBOARD_SUGGESTION_WINDOW_MS may look, once. */
  arm(): void {
    this.armedUntil = this.now() + CLIPBOARD_SUGGESTION_WINDOW_MS;
  }

  /** The key to hand the page, or null. `readText` (Electron's async
   *  clipboard.readText) is called only when the request qualifies. */
  async answer(
    request: ClipboardKeyRequest,
    readText: () => Promise<string> | string,
  ): Promise<string | null> {
    if (!request.fromOffice) return null;
    if (request.purpose === 'suggest') {
      const armed = this.armedUntil > this.now();
      this.armedUntil = 0;
      if (!armed || !request.focused) return null;
      return clipboardKeySuggestion(await readText());
    }
    if (request.purpose === 'paste' && request.focused) {
      return clipboardKey(await readText());
    }
    return null;
  }
}
