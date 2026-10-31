/**
 * `~/.pixel-agents/conductor-state.json`: the provider's own persistence.
 *
 * Holds the scope and, per session, the hidden/pinned flags, when the session
 * was withdrawn from the PC Box, the feed cursor, the harness, the first
 * sender (spawn edge), the newest activity time and when a listing last showed
 * it. Agent ids and Pokémon live in the runtime's stream memory
 * (`<namespace>-state.json` `streamAgents`), beside the seats they key.
 * Written atomically (tmp + rename) with mode 0600. Never the API token, and
 * never message text.
 *
 * What the user decided (scope, hidden, pinned, a withdrawal) is written within
 * a second. Bookkeeping that changes on every poll (cursors, activity times,
 * first senders) is written at most every STATE_LAZY_SAVE_MS and on stop, so an
 * active office does not rewrite the file every second.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { ConductorScope } from '../../../../../core/src/messages.js';
import {
  DEFAULT_SCOPE,
  MAX_ACTIVE_WITHIN_HOURS,
  MAX_SESSIONS_LIMIT,
  STATE_FILE_MODE,
  STATE_FILE_VERSION,
  STATE_LAZY_SAVE_MS,
  STATE_SAVE_DEBOUNCE_MS,
  STATE_SESSIONS_MAX,
  STATE_STALE_ENTRY_MS,
} from './constants.js';

export interface PersistedConductorSession {
  hidden?: boolean;
  pinned?: boolean;
  /** Epoch ms of the last withdrawal from the PC Box (counts as activity). */
  restoredAt?: number;
  cursor?: { lastId: string; lastIndex: number };
  harness?: string;
  /** Item #1's senderSessionId; null when item #1 came from a person. */
  firstSender?: string | null;
  lastActivityAt?: number;
  /** Epoch ms a session listing last showed the session (refreshed daily), so
   *  entries without activity still age out once the session is gone. */
  seenAt?: number;
}

/** Fields the user set: written within STATE_SAVE_DEBOUNCE_MS. */
const URGENT_FIELDS: ReadonlySet<keyof PersistedConductorSession> = new Set([
  'hidden',
  'pinned',
  'restoredAt',
]);

export interface ConductorStateFile {
  version: typeof STATE_FILE_VERSION;
  scope: ConductorScope;
  sessions: Record<string, PersistedConductorSession>;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Coerce anything (file contents, wire input) into a valid scope. */
export function sanitizeScope(raw: unknown, base: ConductorScope = DEFAULT_SCOPE): ConductorScope {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    Record<keyof ConductorScope, unknown>
  >;
  return {
    creator: r.creator === 'all' || r.creator === 'me' ? r.creator : base.creator,
    activeWithinHours: clampInt(
      r.activeWithinHours,
      1,
      MAX_ACTIVE_WITHIN_HOURS,
      base.activeWithinHours,
    ),
    showIdle: typeof r.showIdle === 'boolean' ? r.showIdle : base.showIdle,
    maxSessions: clampInt(r.maxSessions, 1, MAX_SESSIONS_LIMIT, base.maxSessions),
  };
}

function sanitizeSession(raw: unknown): PersistedConductorSession | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: PersistedConductorSession = {};
  if (r.hidden === true) out.hidden = true;
  if (r.pinned === true) out.pinned = true;
  if (isTime(r.restoredAt)) out.restoredAt = r.restoredAt;
  const cursor = r.cursor as Record<string, unknown> | undefined;
  if (cursor && typeof cursor.lastId === 'string' && typeof cursor.lastIndex === 'number') {
    out.cursor = { lastId: cursor.lastId, lastIndex: cursor.lastIndex };
  }
  if (typeof r.harness === 'string') out.harness = r.harness;
  if (typeof r.firstSender === 'string' || r.firstSender === null) out.firstSender = r.firstSender;
  if (isTime(r.lastActivityAt)) out.lastActivityAt = r.lastActivityAt;
  if (isTime(r.seenAt)) out.seenAt = r.seenAt;
  return out;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Newest moment the entry was known to matter (0 when never). */
function recencyOf(entry: PersistedConductorSession): number {
  return Math.max(entry.lastActivityAt ?? 0, entry.seenAt ?? 0, entry.restoredAt ?? 0);
}

export class ConductorStateStore {
  readonly filePath: string;
  private data: ConductorStateFile;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Epoch ms the pending save is due (with saveTimer). */
  private saveDueAt = 0;
  private readonly onError: (message: string) => void;
  private readonly now: () => number;

  constructor(
    filePath: string,
    onError: (message: string) => void = () => {},
    now: () => number = () => Date.now(),
  ) {
    this.filePath = filePath;
    this.onError = onError;
    this.now = now;
    this.data = this.read();
    // Entries from before seenAt existed start their 30 days now.
    const loadedAt = this.now();
    for (const entry of Object.values(this.data.sessions)) {
      if (recencyOf(entry) === 0) entry.seenAt = loadedAt;
    }
  }

  get scope(): ConductorScope {
    return { ...this.data.scope };
  }

  setScope(scope: ConductorScope): void {
    this.data.scope = sanitizeScope(scope, this.data.scope);
    this.scheduleSave(true);
  }

  session(sessionId: string): Readonly<PersistedConductorSession> | undefined {
    return this.data.sessions[sessionId];
  }

  sessionIds(): string[] {
    return Object.keys(this.data.sessions);
  }

  /** Merge fields into a session's entry; `undefined` values delete fields. */
  patchSession(sessionId: string, patch: Partial<PersistedConductorSession>): void {
    const current = this.data.sessions[sessionId] ?? {};
    const next: PersistedConductorSession = { ...current };
    let changed = !this.data.sessions[sessionId];
    let urgent = false;
    for (const [key, value] of Object.entries(patch) as Array<
      [keyof PersistedConductorSession, unknown]
    >) {
      const before = JSON.stringify(current[key]);
      const clears =
        value === undefined || (value === false && (key === 'hidden' || key === 'pinned'));
      if (clears) delete next[key];
      else (next as Record<string, unknown>)[key] = value;
      if (JSON.stringify(next[key]) !== before) {
        changed = true;
        if (URGENT_FIELDS.has(key)) urgent = true;
      }
    }
    if (!changed) return;
    // A new entry starts its 30 days now, whatever it holds.
    if (!this.data.sessions[sessionId] && recencyOf(next) === 0) next.seenAt = this.now();
    this.data.sessions[sessionId] = next;
    this.scheduleSave(urgent);
  }

  /** Write soon: within STATE_SAVE_DEBOUNCE_MS when urgent, else within
   *  STATE_LAZY_SAVE_MS. An urgent change pulls a pending lazy save forward. */
  scheduleSave(urgent = false): void {
    const dueAt = this.now() + (urgent ? STATE_SAVE_DEBOUNCE_MS : STATE_LAZY_SAVE_MS);
    if (this.saveTimer && this.saveDueAt <= dueAt) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveDueAt = dueAt;
    this.saveTimer = setTimeout(
      () => {
        this.saveTimer = undefined;
        this.flush();
      },
      Math.max(0, dueAt - this.now()),
    );
    this.saveTimer.unref?.();
  }

  /** Write now (atomic tmp + rename, mode 0600). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.prune(this.now());
    const dir = path.dirname(this.filePath);
    const tmpPath = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), {
        encoding: 'utf-8',
        mode: STATE_FILE_MODE,
      });
      fs.chmodSync(tmpPath, STATE_FILE_MODE);
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      this.onError(`failed to write ${path.basename(this.filePath)}: ${(err as Error).message}`);
    }
  }

  /** Drop entries nobody asked to keep once they are stale, then the oldest
   *  past STATE_SESSIONS_MAX. Hidden and pinned sessions are always kept. */
  private prune(now: number): void {
    const prunable: Array<[string, number]> = [];
    for (const [id, entry] of Object.entries(this.data.sessions)) {
      if (entry.hidden || entry.pinned) continue;
      const recency = recencyOf(entry);
      if (now - recency > STATE_STALE_ENTRY_MS) delete this.data.sessions[id];
      else prunable.push([id, recency]);
    }
    const excess = Object.keys(this.data.sessions).length - STATE_SESSIONS_MAX;
    if (excess <= 0) return;
    prunable.sort((a, b) => a[1] - b[1]);
    for (const [id] of prunable.slice(0, excess)) delete this.data.sessions[id];
  }

  private read(): ConductorStateFile {
    const empty: ConductorStateFile = {
      version: STATE_FILE_VERSION,
      scope: { ...DEFAULT_SCOPE },
      sessions: {},
    };
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      return empty;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.version !== STATE_FILE_VERSION) return empty;
      const sessions: Record<string, PersistedConductorSession> = {};
      const rawSessions = parsed.sessions;
      if (rawSessions && typeof rawSessions === 'object') {
        for (const [id, value] of Object.entries(rawSessions as Record<string, unknown>)) {
          const entry = sanitizeSession(value);
          if (entry) sessions[id] = entry;
        }
      }
      return { version: STATE_FILE_VERSION, scope: sanitizeScope(parsed.scope), sessions };
    } catch {
      this.onError(`ignoring unreadable ${path.basename(this.filePath)}`);
      return empty;
    }
  }
}
