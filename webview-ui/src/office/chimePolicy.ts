/**
 * Which sound an agentStatus deserves (DESIGN §D "Chimes and selection").
 * Pure and DOM-free so the Node runner can test it; notificationSound.ts
 * plays the result, gated by the Settings sound switch.
 */

/** The done chime, the attention tap, or nothing. */
export type StatusChime = 'done' | 'attention' | null;

export interface StatusChimeInput {
  status: string;
  /** status is 'waiting' and the agent asked the user something. */
  awaitingInput: boolean;
  /** A seeding / reconnect resend — never a sound. */
  silent: boolean;
  /** Fed by a stream provider (Conductor): dozens of them run at once. */
  streamAgent: boolean;
  /** The agent is the office's selected character. */
  selected: boolean;
  /** The agent's session is pinned in the Sessions list. */
  pinned: boolean;
  /** The status differs from the last one this client saw for the agent. */
  changed: boolean;
}

/**
 * Upstream agents keep the upstream rule (every finished turn chimes). A
 * stream agent chimes only when it needs an answer, when a pinned or the
 * selected agent errors (the attention tap), or when the selected agent's
 * status changes to waiting — an office of forty cloud sessions would
 * otherwise chime constantly. Silent resends never sound.
 */
export function statusChimeFor(input: StatusChimeInput): StatusChime {
  if (input.silent) return null;
  if (!input.streamAgent) return input.status === 'waiting' ? 'done' : null;
  if (input.status === 'waiting' && input.awaitingInput) return 'done';
  if (input.status === 'error' && (input.selected || input.pinned)) return 'attention';
  if (input.status === 'waiting' && input.selected && input.changed) return 'done';
  return null;
}
