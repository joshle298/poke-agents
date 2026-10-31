/**
 * Pure list rules for the Sessions modal and Archived sessions (DOM-free,
 * Node-tested).
 */

import type { ConductorSessionSummary } from '../../../core/src/messages.js';

export interface SessionGroup {
  /** Repository slug, or '' for sessions with no repo. */
  repo: string;
  sessions: ConductorSessionSummary[];
}

/** Sessions some other session names as its Lead. A session continued with
 *  another model (Switch model, `handoff`) is not a Lead for it. */
export function leadSessionIds(sessions: readonly ConductorSessionSummary[]): Set<string> {
  const leads = new Set<string>();
  for (const s of sessions) if (s.leadSessionId && !s.handoff) leads.add(s.leadSessionId);
  return leads;
}

function matches(session: ConductorSessionSummary, needle: string): boolean {
  if (!needle) return true;
  return [
    session.label,
    session.workspaceName,
    session.workspaceNumber !== undefined ? `#${session.workspaceNumber}` : undefined,
    session.repo,
    session.model,
    session.harness,
    session.creatorName,
  ].some((field) => field?.toLowerCase().includes(needle));
}

const STATUS_RANK: Record<ConductorSessionSummary['status'], number> = {
  working: 0,
  error: 1,
  idle: 2,
};

/** Pinned first, then working, errored, idle; newest activity first. */
function compareSessions(a: ConductorSessionSummary, b: ConductorSessionSummary): number {
  const pinned = Number(b.pinned === true) - Number(a.pinned === true);
  if (pinned !== 0) return pinned;
  const status = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (status !== 0) return status;
  return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
}

/**
 * Every unarchived session matching the search (hidden ones included), grouped
 * by repository. Groups are alphabetical with the no-repo group last.
 */
export function groupSessions(
  sessions: readonly ConductorSessionSummary[],
  query: string,
): SessionGroup[] {
  const needle = query.trim().toLowerCase();
  const byRepo = new Map<string, ConductorSessionSummary[]>();
  for (const s of sessions) {
    if (s.archived || !matches(s, needle)) continue;
    const repo = s.repo ?? '';
    const list = byRepo.get(repo) ?? [];
    list.push(s);
    byRepo.set(repo, list);
  }
  return [...byRepo.entries()]
    .sort(([a], [b]) => {
      if (a === '') return 1;
      if (b === '') return -1;
      return a.localeCompare(b);
    })
    .map(([repo, list]) => ({ repo, sessions: list.sort(compareSessions) }));
}

/** Archived sessions (the Archive modal), most recently archived first. */
export function archivedSessions(
  sessions: readonly ConductorSessionSummary[],
): ConductorSessionSummary[] {
  return sessions
    .filter((s) => s.archived)
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
}
