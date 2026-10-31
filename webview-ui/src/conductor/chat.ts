/**
 * The Pokédex chat view's rules (DOM-free, Node-tested): merging history
 * pages with the live detail, grouping a turn's tool lines, the reply box's
 * send key and send state, and the thread's sticky scroll.
 */

import type { SessionDetailEntry, SessionQuestionKind } from '../../../core/src/messages.js';
import type { ActionOutcome } from './conductorStore.js';

/** An entry's identity across merged pages: the server's stable key, else
 *  its content. */
export function entryKey(entry: SessionDetailEntry): string {
  return entry.key ?? `${entry.role}|${entry.at}|${entry.text}`;
}

/**
 * One conversation from any number of entry lists (older history pages, the
 * live detail ring), oldest first. An entry seen in several lists appears
 * once; the newest list's copy wins. Entries at the same time keep the order
 * they were given in.
 */
export function mergeEntries(
  ...lists: ReadonlyArray<readonly SessionDetailEntry[] | undefined>
): SessionDetailEntry[] {
  const byKey = new Map<string, { entry: SessionDetailEntry; order: number }>();
  let order = 0;
  for (const list of lists) {
    for (const entry of list ?? []) {
      const key = entryKey(entry);
      const seen = byKey.get(key);
      byKey.set(key, { entry, order: seen ? seen.order : order++ });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => a.entry.at - b.entry.at || a.order - b.order)
    .map((v) => v.entry);
}

export type ThreadItem =
  | { kind: 'message'; key: string; entry: SessionDetailEntry }
  | { kind: 'tools'; key: string; entries: SessionDetailEntry[] };

/** The thread as rendered: messages one by one, and each run of tool lines
 *  between two messages (one turn's tools) as one collapsed group. */
export function buildThread(entries: readonly SessionDetailEntry[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const entry of entries) {
    const key = entryKey(entry);
    const last = items[items.length - 1];
    if (entry.role === 'tool') {
      if (last?.kind === 'tools') last.entries.push(entry);
      else items.push({ kind: 'tools', key, entries: [entry] });
    } else {
      items.push({ kind: 'message', key, entry });
    }
  }
  return items;
}

/** The name a tool line goes by. */
export function toolLabel(entry: SessionDetailEntry): string {
  return entry.toolName?.trim() || 'Tool';
}

/** Tool names a group shows before "+N". */
const TOOL_SUMMARY_NAMES = 3;

/** "3 tools · Bash, Read, Edit", "1 tool · Bash", "7 tools · Bash, Read, Edit +1". */
export function toolGroupSummary(entries: readonly SessionDetailEntry[]): string {
  const names: string[] = [];
  for (const entry of entries) {
    const name = toolLabel(entry);
    if (!names.includes(name)) names.push(name);
  }
  const shown = names.slice(0, TOOL_SUMMARY_NAMES).join(', ');
  const more = names.length > TOOL_SUMMARY_NAMES ? ` +${names.length - TOOL_SUMMARY_NAMES}` : '';
  const count = `${entries.length} ${entries.length === 1 ? 'tool' : 'tools'}`;
  return `${count} · ${shown}${more}`;
}

const QUESTION_TITLE: Record<SessionQuestionKind, string> = {
  askUser: 'Question',
  plan: 'Plan to approve',
  notice: 'Question',
};

/** The heading of a pending question: an AskUserQuestion or an async
 *  question reads "Question", a plan waiting for approval "Plan to approve". */
export function questionTitle(kind: SessionQuestionKind): string {
  return QUESTION_TITLE[kind] ?? 'Question';
}

/** The parts of a keydown the reply box decides on. */
export interface SendKeyEvent {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** keyCode Chromium and Safari report while an IME composition takes a key. */
const IME_PROCESS_KEY_CODE = 229;

/** Enter sends; Shift+Enter is a newline; the Enter that confirms an IME
 *  composition (Japanese, Chinese, Korean input) only confirms it. */
export function isSendKey(e: SendKeyEvent): boolean {
  if (e.key !== 'Enter' || e.shiftKey) return false;
  return !e.isComposing && e.keyCode !== IME_PROCESS_KEY_CODE;
}

export type SendState = 'idle' | 'sending' | 'sent' | 'failed' | 'unconfirmed';

/**
 * Where the last message sent from the Pokédex stands: waiting for its
 * conductorActionResult, sent, refused, or with no answer after `timeoutMs`
 * (it may still have reached Conductor, so the UI says so rather than
 * calling it failed).
 */
export function sendState(
  sentAt: number | null,
  outcome: ActionOutcome | undefined,
  now: number,
  timeoutMs: number,
): SendState {
  if (sentAt === null) return 'idle';
  if (outcome && outcome.action === 'sendSessionMessage' && outcome.at >= sentAt) {
    return outcome.ok ? 'sent' : 'failed';
  }
  return now - sentAt >= timeoutMs ? 'unconfirmed' : 'sending';
}

/** True when the thread is scrolled to (within `slackPx` of) its newest line. */
export function isNearBottom(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
  slackPx: number,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slackPx;
}

/** After older lines were added above, the scrollTop that keeps the lines the
 *  user was reading in place. */
export function scrollTopAfterPrepend(
  before: { scrollHeight: number; scrollTop: number },
  scrollHeightAfter: number,
): number {
  return Math.max(0, before.scrollTop + scrollHeightAfter - before.scrollHeight);
}
