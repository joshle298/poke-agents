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
 * - the same session and reason again within the dedupe window,
 * - more than the rate limit allows across all sessions.
 */

import {
  ADOPTION_GRACE_MS,
  NOTICE_DEDUPE_MS,
  NOTICE_ERROR_MAX_LENGTH,
  NOTICE_RATE_MAX,
  NOTICE_RATE_WINDOW_MS,
} from './constants.js';

export type AttentionKind = 'input' | 'permission' | 'fainted';

/** A notification to show. */
export interface AttentionNotice {
  agentId: number;
  kind: AttentionKind;
  title: string;
  body: string;
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

type Message = Record<string, unknown>;

export class AttentionTracker {
  private readonly sessions = new Map<number, SessionView>();
  private readonly lastNoticeAt = new Map<string, number>();
  private recentNotices: number[] = [];
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

  /** Forget every session: the feed is about to replay the whole office. */
  reset(): void {
    this.sessions.clear();
  }

  /** Sessions currently waiting for an answer or a permission. */
  needsYouCount(): number {
    let count = 0;
    for (const view of this.sessions.values()) if (view.input || view.permission) count++;
    return count;
  }

  /** Apply one office message; returns the notifications it earns. */
  handle(message: unknown): AttentionNotice[] {
    if (!isRecord(message) || typeof message.type !== 'string') return [];
    switch (message.type) {
      case 'existingAgents':
        if (Array.isArray(message.agents)) {
          for (const id of message.agents) if (isAgentId(id)) this.view(id);
        }
        return [];
      case 'agentCreated':
      case 'agentDetails':
        if (isAgentId(message.id)) this.describe(this.view(message.id), message);
        return [];
      case 'agentClosed':
        if (isAgentId(message.id)) this.sessions.delete(message.id);
        return [];
      case 'agentStatus':
        return isAgentId(message.id) ? this.status(message.id, message) : [];
      case 'agentToolPermission': {
        if (!isAgentId(message.id)) return [];
        const view = this.view(message.id);
        const rising = !view.permission;
        view.permission = true;
        return rising ? this.notice(message.id, view, 'permission', false) : [];
      }
      case 'agentToolPermissionClear':
      case 'agentToolsClear':
        if (isAgentId(message.id)) this.view(message.id).permission = false;
        return [];
      case 'settingsLoaded':
        if (typeof message.pokemonTheme === 'boolean') this.themed = message.pokemonTheme;
        return [];
      case 'pokemonThemeUpdated':
        if (typeof message.enabled === 'boolean') this.themed = message.enabled;
        return [];
      default:
        return [];
    }
  }

  private status(id: number, message: Message): AttentionNotice[] {
    const view = this.view(id);
    const silent = message.silent === true;
    switch (message.status) {
      case 'waiting': {
        const input = message.awaitingInput === true;
        const rising = input && !view.input;
        // A resend of the plain waiting status (a replay) says nothing about
        // whether the session is still asking: only a live one clears it.
        if (input || !silent) view.input = input;
        view.errored = false;
        return rising ? this.notice(id, view, 'input', silent) : [];
      }
      case 'error': {
        const rising = !view.errored;
        view.errored = true;
        view.input = false;
        view.errorMessage =
          typeof message.errorMessage === 'string' ? message.errorMessage : undefined;
        return rising ? this.notice(id, view, 'fainted', silent) : [];
      }
      case 'active':
        view.input = false;
        view.errored = false;
        return [];
      default:
        return [];
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

  private notice(
    id: number,
    view: SessionView,
    kind: AttentionKind,
    silent: boolean,
  ): AttentionNotice[] {
    const now = this.now();
    if (silent || now < this.quietUntil || now - view.seenAt < this.graceMs) return [];
    const key = `${id}:${kind}`;
    const last = this.lastNoticeAt.get(key);
    if (last !== undefined && now - last < this.dedupeMs) return [];
    this.recentNotices = this.recentNotices.filter((at) => now - at < this.rateWindowMs);
    if (this.recentNotices.length >= this.rateMax) return [];
    this.recentNotices.push(now);
    this.lastNoticeAt.set(key, now);
    return [this.text(id, view, kind)];
  }

  /** "Pikachu needs your answer" over the session name; with the theme off
   *  (or an unknown species) the session name leads instead. */
  private text(id: number, view: SessionView, kind: AttentionKind): AttentionNotice {
    const species =
      this.themed && view.species !== undefined ? this.speciesName(view.species) : undefined;
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
    return { agentId: id, kind, title, body };
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
