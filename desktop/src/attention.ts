/**
 * Which sessions need the user, read from the office's own message stream
 * (the broadcasts every office window receives), and which changes deserve a
 * desktop notification. Pure: no Electron and no timers; the clock is injected.
 *
 * A session NEEDS YOU while it waits for an answer (`agentStatus` waiting with
 * `awaitingInput`) or for a permission (`agentToolPermission`); the Dock badge
 * counts those. It FAINTS when its turn ends in an error. A notification fires
 * on the change into one of those states, never for:
 * - `silent` messages (seeds and reconnect resends),
 * - the first ADOPTION_GRACE_MS of a session in this office (its state on
 *   arrival is where it already was, not news),
 * - a quiet window after connecting (`quiet()`),
 * - the same session and reason again within the dedupe window.
 *
 * Past the rate limit (across all sessions) a notice is held back, and
 * `flush()` folds the held ones into one summary ("2 more sessions need you")
 * once the window has room. Each notice has a stable id (session and reason),
 * so a repeat replaces it; when the reason clears (the session answered,
 * continued or left) its id comes back in `withdrawn` so the notification can
 * be taken down.
 */

import {
  ADOPTION_GRACE_MS,
  NOTICE_DEDUPE_MS,
  NOTICE_ERROR_MAX_LENGTH,
  NOTICE_RATE_MAX,
  NOTICE_RATE_WINDOW_MS,
  SUMMARY_MAX_NAMES,
  SUMMARY_NOTICE_ID,
} from './constants.js';

export type AttentionKind = 'input' | 'permission' | 'fainted';

/** A notification to show. */
export interface AttentionNotice {
  /** `<agentId>:<kind>`, or SUMMARY_NOTICE_ID. A newer notice with the same
   *  id replaces the older one. */
  id: string;
  /** The session it is about; absent for a summary of several. */
  agentId?: number;
  kind: AttentionKind | 'summary';
  title: string;
  body: string;
}

/** What one message (or a flush) changes. */
export interface AttentionUpdate {
  notices: AttentionNotice[];
  /** Ids of notices given out earlier whose reason has cleared. */
  withdrawn: string[];
}

export interface AttentionOptions {
  now?: () => number;
  /** Dex number → species name ("Pikachu"). */
  speciesName?: (dex: number) => string | undefined;
  /** Name sessions by their Pokémon (the office's Pokémon theme). Default on;
   *  `settingsLoaded` and `pokemonThemeUpdated` keep it current. */
  themed?: boolean;
  adoptionGraceMs?: number;
  dedupeMs?: number;
  rateMax?: number;
  rateWindowMs?: number;
}

interface SessionView {
  label?: string;
  species?: number;
  /** When this office first heard of the session. */
  seenAt: number;
  input: boolean;
  permission: boolean;
  errored: boolean;
  errorMessage?: string;
}

interface Held {
  agentId: number;
  kind: AttentionKind;
}

type Message = Record<string, unknown>;

const KINDS: readonly AttentionKind[] = ['input', 'permission', 'fainted'];

const noticeId = (agentId: number, kind: AttentionKind): string => `${agentId}:${kind}`;

export class AttentionTracker {
  private readonly sessions = new Map<number, SessionView>();
  private readonly lastNoticeAt = new Map<string, number>();
  private recentNotices: number[] = [];
  /** Ids of individual notices given out and not yet withdrawn. */
  private readonly outstanding = new Set<string>();
  /** Notices held back by the rate limit, by id, for the next summary. */
  private readonly held = new Map<string, Held>();
  /** Ids the outstanding summary covers. */
  private readonly summarized = new Set<string>();
  private quietUntil = 0;
  private themed: boolean;
  private readonly now: () => number;
  private readonly speciesName: (dex: number) => string | undefined;
  private readonly graceMs: number;
  private readonly dedupeMs: number;
  private readonly rateMax: number;
  private readonly rateWindowMs: number;

  constructor(options: AttentionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.speciesName = options.speciesName ?? (() => undefined);
    this.themed = options.themed ?? true;
    this.graceMs = options.adoptionGraceMs ?? ADOPTION_GRACE_MS;
    this.dedupeMs = options.dedupeMs ?? NOTICE_DEDUPE_MS;
    this.rateMax = options.rateMax ?? NOTICE_RATE_MAX;
    this.rateWindowMs = options.rateWindowMs ?? NOTICE_RATE_WINDOW_MS;
  }

  /** Treat everything in the next `ms` as state, not news. */
  quiet(ms: number): void {
    this.quietUntil = Math.max(this.quietUntil, this.now() + ms);
  }

  /** Name sessions by their Pokémon (theme on) or by their session name. */
  setThemed(themed: boolean): void {
    this.themed = themed;
  }

  /** Forget every session and notice: the feed is about to replay the whole
   *  office (the caller takes down the notifications it showed). The dedupe
   *  and rate limit carry over, so a replay can't set off a storm. */
  reset(): void {
    this.sessions.clear();
    this.outstanding.clear();
    this.held.clear();
    this.summarized.clear();
  }

  /** Sessions currently waiting for an answer or a permission. */
  needsYouCount(): number {
    let count = 0;
    for (const view of this.sessions.values()) if (view.input || view.permission) count++;
    return count;
  }

  /** Apply one office message. */
  handle(message: unknown): AttentionUpdate {
    const update: AttentionUpdate = { notices: [], withdrawn: [] };
    if (!isRecord(message) || typeof message.type !== 'string') return update;
    switch (message.type) {
      case 'existingAgents':
        if (Array.isArray(message.agents)) {
          for (const id of message.agents) if (isAgentId(id)) this.view(id);
        }
        break;
      case 'agentCreated':
      case 'agentDetails':
        if (isAgentId(message.id)) this.describe(this.view(message.id), message);
        break;
      case 'agentClosed':
        if (isAgentId(message.id)) {
          for (const kind of KINDS) this.clear(message.id, kind, update);
          this.sessions.delete(message.id);
        }
        break;
      case 'agentStatus':
        if (isAgentId(message.id)) this.status(message.id, message, update);
        break;
      case 'agentToolPermission':
        if (isAgentId(message.id)) {
          const view = this.view(message.id);
          const rising = !view.permission;
          view.permission = true;
          if (rising) this.notice(message.id, view, 'permission', false, update);
        }
        break;
      case 'agentToolPermissionClear':
      case 'agentToolsClear':
        if (isAgentId(message.id)) {
          this.view(message.id).permission = false;
          this.clear(message.id, 'permission', update);
        }
        break;
      case 'settingsLoaded':
        if (typeof message.pokemonTheme === 'boolean') this.themed = message.pokemonTheme;
        break;
      case 'pokemonThemeUpdated':
        if (typeof message.enabled === 'boolean') this.themed = message.enabled;
        break;
    }
    return update;
  }

  /** When `flush()` can next send held notices, or null when none are held. */
  nextFlushAt(): number | null {
    if (this.held.size === 0) return null;
    const now = this.now();
    this.pruneRecent(now);
    if (this.recentNotices.length < this.rateMax) return now;
    return this.recentNotices[0] + this.rateWindowMs;
  }

  /**
   * Send what the rate limit held back, if the window has room: one notice
   * as itself, several as one summary. Held notices whose reason has since
   * cleared are dropped.
   */
  flush(): AttentionUpdate {
    const update: AttentionUpdate = { notices: [], withdrawn: [] };
    for (const [id, { agentId, kind }] of this.held) {
      if (!this.isActive(agentId, kind)) this.held.delete(id);
    }
    if (this.held.size === 0) return update;
    const now = this.now();
    this.pruneRecent(now);
    if (this.recentNotices.length >= this.rateMax) return update;

    const entries = [...this.held.entries()];
    this.held.clear();
    this.recentNotices.push(now);
    for (const [id] of entries) this.lastNoticeAt.set(id, now);
    if (entries.length === 1) {
      const [id, { agentId, kind }] = entries[0];
      this.outstanding.add(id);
      update.notices.push(this.text(agentId, this.view(agentId), kind));
      return update;
    }
    this.summarized.clear();
    for (const [id] of entries) this.summarized.add(id);
    this.outstanding.add(SUMMARY_NOTICE_ID);
    const names = entries.map(([, { agentId }]) => this.name(this.view(agentId)));
    const shown = names.slice(0, SUMMARY_MAX_NAMES).join(', ');
    const rest = names.length - SUMMARY_MAX_NAMES;
    update.notices.push({
      id: SUMMARY_NOTICE_ID,
      kind: 'summary',
      title: `${entries.length} more sessions need you`,
      body: rest > 0 ? `${shown} and ${rest} more` : shown,
    });
    return update;
  }

  private status(id: number, message: Message, update: AttentionUpdate): void {
    const view = this.view(id);
    const silent = message.silent === true;
    switch (message.status) {
      case 'waiting': {
        const input = message.awaitingInput === true;
        const rising = input && !view.input;
        // A resend of the plain waiting status (a replay) says nothing about
        // whether the session is still asking: only a live one clears it.
        if (input || !silent) {
          view.input = input;
          if (!input) this.clear(id, 'input', update);
        }
        view.errored = false;
        this.clear(id, 'fainted', update);
        if (rising) this.notice(id, view, 'input', silent, update);
        return;
      }
      case 'error': {
        const rising = !view.errored;
        view.errored = true;
        view.input = false;
        this.clear(id, 'input', update);
        view.errorMessage =
          typeof message.errorMessage === 'string' ? message.errorMessage : undefined;
        if (rising) this.notice(id, view, 'fainted', silent, update);
        return;
      }
      case 'active':
        view.input = false;
        view.errored = false;
        this.clear(id, 'input', update);
        this.clear(id, 'fainted', update);
        return;
    }
  }

  private view(id: number): SessionView {
    let view = this.sessions.get(id);
    if (!view) {
      view = { seenAt: this.now(), input: false, permission: false, errored: false };
      this.sessions.set(id, view);
    }
    return view;
  }

  private describe(view: SessionView, message: Message): void {
    if (typeof message.label === 'string' && message.label.trim())
      view.label = message.label.trim();
    if (isAgentId(message.species)) view.species = message.species;
  }

  private isActive(agentId: number, kind: AttentionKind): boolean {
    const view = this.sessions.get(agentId);
    if (!view) return false;
    return kind === 'input' ? view.input : kind === 'permission' ? view.permission : view.errored;
  }

  /** The reason behind a notice cleared: withdraw it if it was given out. */
  private clear(agentId: number, kind: AttentionKind, update: AttentionUpdate): void {
    const id = noticeId(agentId, kind);
    this.held.delete(id);
    if (this.outstanding.delete(id)) update.withdrawn.push(id);
    if (this.summarized.delete(id) && this.summarized.size === 0) {
      if (this.outstanding.delete(SUMMARY_NOTICE_ID)) update.withdrawn.push(SUMMARY_NOTICE_ID);
    }
  }

  private pruneRecent(now: number): void {
    this.recentNotices = this.recentNotices.filter((at) => now - at < this.rateWindowMs);
  }

  private notice(
    agentId: number,
    view: SessionView,
    kind: AttentionKind,
    silent: boolean,
    update: AttentionUpdate,
  ): void {
    const now = this.now();
    if (silent || now < this.quietUntil || now - view.seenAt < this.graceMs) return;
    const id = noticeId(agentId, kind);
    const last = this.lastNoticeAt.get(id);
    if (last !== undefined && now - last < this.dedupeMs) return;
    this.pruneRecent(now);
    if (this.recentNotices.length >= this.rateMax) {
      this.held.set(id, { agentId, kind });
      return;
    }
    this.recentNotices.push(now);
    this.lastNoticeAt.set(id, now);
    this.outstanding.add(id);
    update.notices.push(this.text(agentId, view, kind));
  }

  /** The species name when the theme is on and the species is known. */
  private species(view: SessionView): string | undefined {
    return this.themed && view.species !== undefined ? this.speciesName(view.species) : undefined;
  }

  /** How a summary names a session: its Pokémon, else its session name. */
  private name(view: SessionView): string {
    return this.species(view) ?? view.label ?? 'A Conductor session';
  }

  /** "Pikachu needs your answer" over the session name; with the theme off
   *  (or an unknown species) the session name leads instead. */
  private text(agentId: number, view: SessionView, kind: AttentionKind): AttentionNotice {
    const species = this.species(view);
    const label = view.label ?? 'A Conductor session';
    const who = species ?? label;
    const detail = species ? label : '';
    let title: string;
    let body = detail;
    switch (kind) {
      case 'input':
        title = `${who} needs your answer`;
        break;
      case 'permission':
        title = `${who} needs your permission`;
        break;
      case 'fainted': {
        title = species ? `${species} fainted!` : `${label} hit an error`;
        const error = clip(view.errorMessage, NOTICE_ERROR_MAX_LENGTH);
        body = [detail, error].filter(Boolean).join('\n');
        break;
      }
    }
    return { id: noticeId(agentId, kind), agentId, kind, title, body };
  }
}

function clip(text: string | undefined, max: number): string | undefined {
  const clean = text?.replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function isRecord(value: unknown): value is Message {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAgentId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
