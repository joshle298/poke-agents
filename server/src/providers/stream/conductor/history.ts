/**
 * Older conversation for the Pokédex chat view (StreamProvider.getSessionHistory).
 *
 * A page is a slice of the session's feed, `[start, end)` by offset, fetched on
 * demand and normalized here into the same entries the live log keeps
 * (sessionLog.ts): user messages, assistant text, tool lines with their
 * canonical tool name, and messages to and from other sessions, with the same
 * keys, so the office can merge pages and the live entries without duplicates.
 * Pure: a fresh normalizer state and a throwaway link tracker per page, so a
 * page never moves the office or the live links.
 *
 * The cursor is opaque to clients: `o<offset>`, the offset of the oldest item
 * already delivered; the next page ends there. Feeds only grow, so offsets of
 * older items never shift.
 */

import type { StreamSessionDetail } from '../../../../../core/src/provider.js';
import { HISTORY_CURSOR_PATTERN, LOG_ASSISTANT_MAX, LOG_USER_MAX } from './constants.js';
import type { Harness } from './harness.js';
import { LinkTracker } from './links.js';
import { normalizeItem } from './normalize/index.js';
import { clipText, createNormState, itemTime } from './normalize/shared.js';
import { formatConductorToolStatus } from './tools.js';
import type { ConductorItem } from './types.js';

type Entry = StreamSessionDetail['entries'][number];

export function formatHistoryCursor(offset: number): string {
  return `o${offset}`;
}

/** The offset a cursor names, or undefined for anything this provider never issued. */
export function parseHistoryCursor(cursor: unknown): number | undefined {
  if (typeof cursor !== 'string') return undefined;
  const match = HISTORY_CURSOR_PATTERN.exec(cursor);
  if (!match) return undefined;
  const offset = Number(match[1]);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : undefined;
}

/** One page of `sessionId`'s feed as Pokédex entries, oldest first. */
export function historyEntries(
  sessionId: string,
  items: ConductorItem[],
  init: { harness?: Harness; resolvedModel?: string },
): Entry[] {
  const norm = createNormState(init);
  const links = new LinkTracker();
  const entries: Entry[] = [];
  const byKey = new Map<string, Entry>();
  const add = (entry: Entry) => {
    if (entry.key && byKey.has(entry.key)) return;
    if (entry.key) byKey.set(entry.key, entry);
    entries.push(entry);
  };
  for (const item of items) {
    if (!item?.id) continue;
    for (const event of normalizeItem(item, norm)) {
      if (event.kind === 'log') {
        if (event.role === 'user' && event.senderSessionId) {
          add({
            role: 'peerIn',
            text: clipText(event.text, LOG_USER_MAX),
            at: event.at,
            peerSessionId: event.senderSessionId,
            key: `peerIn:${event.itemId}`,
          });
        } else if (event.role === 'tool') {
          const entry: Entry = {
            role: 'tool',
            text: clipText(event.text, LOG_ASSISTANT_MAX),
            at: event.at,
            key: event.itemId,
          };
          if (event.toolName) entry.toolName = event.toolName;
          add(entry);
        } else {
          const max = event.role === 'user' ? LOG_USER_MAX : LOG_ASSISTANT_MAX;
          add({
            role: event.role,
            text: clipText(event.text, max),
            at: event.at,
            key: event.itemId,
          });
        }
      } else if (event.kind === 'toolStart') {
        add({
          role: 'tool',
          text: clipText(formatConductorToolStatus(event.toolName, event.input), LOG_ASSISTANT_MAX),
          at: itemTime(item),
          toolName: event.toolName,
          key: `tool:${event.toolId}`,
        });
      }
    }
    // Messages this session sent (its own Conductor CLI calls).
    const observed = links.observe(sessionId, item, { live: false });
    for (const { event, edge } of observed.emit) {
      if (event.kind === 'watched' || event.fromSessionId !== sessionId) continue;
      add({
        role: 'peerOut',
        text: clipText(event.preview ?? '', LOG_USER_MAX),
        at: event.at,
        peerSessionId: event.toSessionId,
        key: `peerOut:${edge.messageId ?? edge.key}`,
      });
    }
  }
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.at - b.entry.at || a.index - b.index)
    .map(({ entry }) => entry);
}
