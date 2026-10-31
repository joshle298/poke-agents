/**
 * `~/.pixel-agents/conductor-state.json`: the provider's own persistence.
 *
 * Holds the scope and, per session, the stable agent id, hidden/pinned flags,
 * the Pokémon line, the feed cursor, the harness, the first sender (spawn edge)
 * and the newest activity time. Written atomically (tmp + rename) with mode
 * 0600. Never the API token, and never message text.
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
  STATE_SAVE_DEBOUNCE_MS,
} from './constants.js';

export interface PersistedConductorSession {
  agentId?: number;
  hidden?: boolean;
  pinned?: boolean;
  pokemonLine?: string;
  shiny?: boolean;
  cursor?: { lastId: string; lastIndex: number };
  harness?: string;
  /** Item #1's senderSessionId; null when item #1 came from a person. */
  firstSender?: string | null;
  lastActivityAt?: number;
}

export interface ConductorStateFile {
  version: typeof STATE_FILE_VERSION;
  scope: ConductorScope;
  sessions: Record<string, PersistedConductorSession>;
}

/** Entries with nothing to keep are dropped once this stale. */
const STALE_ENTRY_MS = 30 * 24 * 60 * 60_000;

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
  if (typeof r.agentId === 'number' && Number.isInteger(r.agentId) && r.agentId > 0) {
    out.agentId = r.agentId;
  }
  if (r.hidden === true) out.hidden = true;
  if (r.pinned === true) out.pinned = true;
  if (typeof r.pokemonLine === 'string') out.pokemonLine = r.pokemonLine;
  if (typeof r.shiny === 'boolean') out.shiny = r.shiny;
  const cursor = r.cursor as Record<string, unknown> | undefined;
  if (cursor && typeof cursor.lastId === 'string' && typeof cursor.lastIndex === 'number') {
    out.cursor = { lastId: cursor.lastId, lastIndex: cursor.lastIndex };
  }
  if (typeof r.harness === 'string') out.harness = r.harness;
  if (typeof r.firstSender === 'string' || r.firstSender === null) out.firstSender = r.firstSender;
  if (typeof r.lastActivityAt === 'number') out.lastActivityAt = r.lastActivityAt;
  return out;
}

export class ConductorStateStore {
  readonly filePath: string;
  private data: ConductorStateFile;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onError: (message: string) => void;

  constructor(filePath: string, onError: (message: string) => void = () => {}) {
    this.filePath = filePath;
    this.onError = onError;
    this.data = this.read();
  }

  get scope(): ConductorScope {
    return { ...this.data.scope };
  }

  setScope(scope: ConductorScope): void {
    this.data.scope = sanitizeScope(scope, this.data.scope);
    this.scheduleSave();
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
    for (const [key, value] of Object.entries(patch) as Array<
      [keyof PersistedConductorSession, unknown]
    >) {
      const before = JSON.stringify(current[key]);
      const clears =
        value === undefined || (value === false && (key === 'hidden' || key === 'pinned'));
      if (clears) delete next[key];
      else (next as Record<string, unknown>)[key] = value;
      if (JSON.stringify(next[key]) !== before) changed = true;
    }
    if (!changed) return;
    this.data.sessions[sessionId] = next;
    this.scheduleSave();
  }

  /** Highest agent id reserved by any session (the runtime allocates above it). */
  maxAgentId(): number {
    let max = 0;
    for (const entry of Object.values(this.data.sessions)) {
      if (entry.agentId && entry.agentId > max) max = entry.agentId;
    }
    return max;
  }

  scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, STATE_SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  /** Write now (atomic tmp + rename, mode 0600). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.pruneStale(Date.now());
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

  private pruneStale(now: number): void {
    for (const [id, entry] of Object.entries(this.data.sessions)) {
      if (entry.hidden || entry.pinned) continue;
      if (entry.lastActivityAt && now - entry.lastActivityAt > STALE_ENTRY_MS) {
        delete this.data.sessions[id];
      }
    }
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
