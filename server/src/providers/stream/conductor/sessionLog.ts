/**
 * Recent conversation context per session for the Pokédex panel: the task
 * prompt plus a ring of the last 40 entries (user messages, assistant text,
 * the last few tool labels, and messages exchanged with other sessions).
 *
 * In memory only: message text is user content and never reaches disk or logs.
 */

import type { StreamSessionDetail } from '../../../../../core/src/provider.js';
import {
  LOG_ASSISTANT_MAX,
  LOG_CAPACITY,
  LOG_KEY_MEMORY,
  LOG_PROMPT_MAX,
  LOG_TOOL_KEEP,
  LOG_USER_MAX,
} from './constants.js';
import { clipText } from './normalize/shared.js';

type Entry = StreamSessionDetail['entries'][number];

interface StoredEntry extends Entry {
  /** Dedupe/update key: feed item id or message id. */
  key?: string;
}

interface SessionLog {
  prompt?: string;
  entries: StoredEntry[];
  keys: Set<string>;
  /** Entries were dropped, or the log started mid-session. */
  truncated: boolean;
}

export class SessionLogStore {
  private readonly logs = new Map<string, SessionLog>();

  private log(sessionId: string): SessionLog {
    let log = this.logs.get(sessionId);
    if (!log) {
      log = { entries: [], keys: new Set(), truncated: false };
      this.logs.set(sessionId, log);
    }
    return log;
  }

  has(sessionId: string): boolean {
    return this.logs.has(sessionId);
  }

  clear(sessionId: string): void {
    this.logs.delete(sessionId);
  }

  /** The first user message seen (item #1 when probed). Never overwritten. */
  setPrompt(sessionId: string, text: string): void {
    const log = this.log(sessionId);
    if (log.prompt === undefined && text.trim()) log.prompt = clipText(text, LOG_PROMPT_MAX);
  }

  /** Mark that older history exists beyond what the log holds. */
  markTruncated(sessionId: string): void {
    this.log(sessionId).truncated = true;
  }

  addUser(sessionId: string, text: string, at: number, key?: string): void {
    this.push(sessionId, { role: 'user', text: clipText(text, LOG_USER_MAX), at, key });
  }

  addAssistant(sessionId: string, text: string, at: number, key?: string): void {
    this.push(sessionId, { role: 'assistant', text: clipText(text, LOG_ASSISTANT_MAX), at, key });
  }

  addTool(sessionId: string, label: string, at: number, key?: string): void {
    this.push(sessionId, { role: 'tool', text: clipText(label, LOG_ASSISTANT_MAX), at, key });
  }

  /** A message to or from another session. Re-adding the same key updates its text. */
  addPeer(
    sessionId: string,
    role: 'peerIn' | 'peerOut',
    peerSessionId: string,
    text: string,
    at: number,
    key?: string,
  ): void {
    const log = this.log(sessionId);
    const entryKey = key ? `${role}:${key}` : undefined;
    if (entryKey && log.keys.has(entryKey)) {
      const existing = log.entries.find((e) => e.key === entryKey);
      if (existing && text) existing.text = clipText(text, LOG_USER_MAX);
      return;
    }
    this.push(sessionId, {
      role,
      text: clipText(text, LOG_USER_MAX),
      at,
      peerSessionId,
      key: entryKey,
    });
  }

  get(
    sessionId: string,
    peerLabel?: (peerSessionId: string) => string | undefined,
  ): StreamSessionDetail {
    const log = this.logs.get(sessionId);
    if (!log) return { entries: [] };
    const entries = log.entries.map((stored) => {
      const entry: Entry = { role: stored.role, text: stored.text, at: stored.at };
      if (stored.peerSessionId) {
        entry.peerSessionId = stored.peerSessionId;
        const label = peerLabel?.(stored.peerSessionId);
        if (label) entry.peerLabel = label;
      }
      return entry;
    });
    const detail: StreamSessionDetail = { entries };
    if (log.prompt !== undefined) detail.prompt = log.prompt;
    if (log.truncated) detail.truncated = true;
    return detail;
  }

  private push(sessionId: string, entry: StoredEntry): void {
    const log = this.log(sessionId);
    if (entry.key) {
      if (log.keys.has(entry.key)) return;
      log.keys.add(entry.key);
      if (log.keys.size > LOG_KEY_MEMORY) {
        const oldest = log.keys.values().next().value;
        if (oldest !== undefined) log.keys.delete(oldest);
      }
    }
    // Keep time order even when a backfill lands after live entries.
    let i = log.entries.length;
    while (i > 0 && log.entries[i - 1].at > entry.at) i--;
    log.entries.splice(i, 0, entry);
    if (entry.role === 'tool') {
      const tools = log.entries.filter((e) => e.role === 'tool');
      for (const old of tools.slice(0, Math.max(0, tools.length - LOG_TOOL_KEEP))) {
        this.remove(log, old);
      }
    }
    while (log.entries.length > LOG_CAPACITY) {
      this.remove(log, log.entries[0]);
      log.truncated = true;
    }
  }

  private remove(log: SessionLog, entry: StoredEntry): void {
    const index = log.entries.indexOf(entry);
    if (index >= 0) log.entries.splice(index, 1);
    // Keep the key: a replayed page must not resurrect an evicted entry.
  }
}
