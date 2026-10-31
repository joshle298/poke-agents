/**
 * Where the office window may go. It stays on the office's own origin; web
 * links open in the default browser; Conductor deep links go to the system,
 * through the same allowlist the server applies to `openExternal`
 * (`conductor:` or `conductor-<channel>:` naming the `workspace` host).
 * Anything else is blocked.
 */

import { isAllowedExternalUrl } from '../../server/src/streamSessionMessages.js';

export type NavigationVerdict =
  /** Same origin as the office: let the window load it. */
  | 'office'
  /** An http(s) page: open it in the default browser. */
  | 'browser'
  /** A Conductor deep link: hand it to the system (the Conductor app). */
  | 'conductor'
  | 'block';

export function classifyNavigation(target: string, officeOrigin: string): NavigationVerdict {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return 'block';
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (url.origin === officeOrigin) return 'office';
    // Credentials in a link are a phishing tell, never something the office makes.
    return url.username || url.password ? 'block' : 'browser';
  }
  return isAllowedExternalUrl(target) ? 'conductor' : 'block';
}
