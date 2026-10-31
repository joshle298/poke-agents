import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConductorSessionSummary, ConductorStatus } from '../../core/src/messages.js';
import {
  agoText,
  conductorStatusLine,
  isConductorDeepLink,
  modelLabel,
  needsSignIn,
  safeHttpsUrl,
  shortAge,
  windowLabel,
  windowOptions,
  workspaceLabel,
} from '../src/conductor/format.js';
import { readBoolPref, writeBoolPref } from '../src/conductor/preferences.js';
import { archivedSessions, groupSessions, leadSessionIds } from '../src/conductor/sessionsView.js';
import { CONDUCTOR_SCOPE_WINDOW_HOURS } from '../src/constants.js';

const scope = { creator: 'me' as const, activeWithinHours: 6, showIdle: true, maxSessions: 24 };

function status(patch: Partial<ConductorStatus>): ConductorStatus {
  return { type: 'conductorStatus', state: 'connected', scope, ...patch };
}

function session(patch: Partial<ConductorSessionSummary>): ConductorSessionSummary {
  return {
    sessionId: 's',
    label: 'Session',
    workspaceId: 'w',
    workspaceName: 'ws',
    status: 'idle',
    hidden: false,
    ...patch,
  };
}

describe('conductorStatusLine', () => {
  const now = 1_000_000;

  it('summarizes a connected account with counts and sync age', () => {
    expect(
      conductorStatusLine(
        status({
          account: 'dev@example.com',
          visibleCount: 14,
          sessionCount: 22,
          lastSyncAt: now - 3_000,
        }),
        now,
      ),
    ).toBe('Conductor: dev@example.com · 14 of 22 sessions shown · synced just now');
    expect(conductorStatusLine(status({ lastSyncAt: now - 42_000 }), now)).toBe(
      'Conductor · synced 42s ago',
    );
  });

  it('explains each failure state without exposing a token', () => {
    expect(conductorStatusLine(null, now)).toBe('Connecting to Conductor…');
    expect(conductorStatusLine(status({ state: 'authRequired' }), now)).toContain(
      'conductor auth login',
    );
    expect(
      conductorStatusLine(status({ state: 'authRequired', message: 'Custom sign-in' }), now),
    ).toBe('Custom sign-in');
    expect(conductorStatusLine(status({ state: 'unauthorized' }), now)).toContain('rejected');
    expect(conductorStatusLine(status({ state: 'unreachable' }), now)).toContain("Can't reach");
    expect(conductorStatusLine(status({ state: 'rateLimited' }), now)).toContain('rate limiting');
  });

  it('flags the states that need the user to sign in', () => {
    expect(needsSignIn(status({ state: 'authRequired' }))).toBe(true);
    expect(needsSignIn(status({ state: 'unauthorized' }))).toBe(true);
    expect(needsSignIn(status({ state: 'unreachable' }))).toBe(false);
    expect(needsSignIn(null)).toBe(false);
  });
});

describe('small formatters', () => {
  it('formats ages', () => {
    expect(shortAge(10_000, 12_000)).toBe('now');
    expect(shortAge(0, 59_000)).toBe('59s');
    expect(shortAge(0, 5 * 60_000)).toBe('5m');
    expect(shortAge(0, 3 * 3_600_000)).toBe('3h');
    expect(shortAge(0, 72 * 3_600_000)).toBe('3d');
    expect(agoText(0, 5 * 60_000)).toBe('5m ago');
    expect(agoText(1, 2)).toBe('just now');
  });

  it('formats workspaces, models and scope windows', () => {
    expect(workspaceLabel(12, 'fix-login')).toBe('#12 fix-login');
    expect(workspaceLabel(12)).toBe('#12');
    expect(workspaceLabel(undefined, 'fix-login')).toBe('fix-login');
    expect(modelLabel('gpt-5', 'codex')).toBe('gpt-5 · codex');
    expect(modelLabel(undefined, 'codex')).toBe('codex');
    expect(windowLabel(0)).toBe('All (30d)');
    expect(windowLabel(24)).toBe('24h');
  });

  it('offers "All" (0, the server\'s 30-day maximum) last and shows a value the server applied', () => {
    const labels = (current?: number) =>
      windowOptions(CONDUCTOR_SCOPE_WINDOW_HOURS, current).map((o) => o.label);
    expect(labels()).toEqual(['1h', '6h', '24h', '72h', 'All (30d)']);
    expect(windowOptions(CONDUCTOR_SCOPE_WINDOW_HOURS, 0).at(-1)).toEqual({
      value: 0,
      label: 'All (30d)',
    });
    // A window the server clamped or kept from an older build stays visible.
    expect(labels(12)).toEqual(['1h', '6h', '12h', '24h', '72h', 'All (30d)']);
    expect(labels(720)).toEqual(['1h', '6h', '24h', '72h', '720h', 'All (30d)']);
    expect(labels(-1)).toEqual(['1h', '6h', '24h', '72h', 'All (30d)']);
  });
});

describe('isConductorDeepLink', () => {
  it('accepts conductor workspace links', () => {
    expect(isConductorDeepLink('conductor://workspace?id=w&session=s')).toBe(true);
    expect(isConductorDeepLink('conductor-dev://workspace?id=w')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isConductorDeepLink(undefined)).toBe(false);
    expect(isConductorDeepLink('')).toBe(false);
    expect(isConductorDeepLink('https://conductor.build')).toBe(false);
    expect(isConductorDeepLink('conductor://settings')).toBe(false);
    expect(isConductorDeepLink('javascript:alert(1)')).toBe(false);
    expect(isConductorDeepLink('not a url')).toBe(false);
  });

  it('lets only https credit links through', () => {
    expect(safeHttpsUrl('https://sprites.pmdcollab.org/#/0025')).toBe(
      'https://sprites.pmdcollab.org/#/0025',
    );
    expect(safeHttpsUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeHttpsUrl('')).toBeUndefined();
  });
});

describe('Sessions modal lists', () => {
  const sessions = [
    session({ sessionId: 'a', label: 'Lead', repo: 'acme/web', status: 'idle', lastActivityAt: 5 }),
    session({
      sessionId: 'b',
      label: 'Child',
      repo: 'acme/web',
      status: 'working',
      leadSessionId: 'a',
      lastActivityAt: 1,
    }),
    session({ sessionId: 'c', label: 'Pinned', repo: 'acme/web', pinned: true, hidden: true }),
    session({ sessionId: 'd', label: 'Docs', repo: 'acme/docs', model: 'gpt-5' }),
    session({ sessionId: 'e', label: 'Loose', workspaceName: 'scratch' }),
    session({ sessionId: 'f', label: 'Old', repo: 'acme/web', archived: true, archivedAt: 10 }),
    session({ sessionId: 'g', label: 'Older', archived: true, archivedAt: 5 }),
  ];

  it('groups unarchived sessions by repo, no-repo last, pinned then working first', () => {
    const groups = groupSessions(sessions, '');
    expect(groups.map((g) => g.repo)).toEqual(['acme/docs', 'acme/web', '']);
    expect(groups[1].sessions.map((s) => s.sessionId)).toEqual(['c', 'b', 'a']);
  });

  it('searches every field, hidden sessions included', () => {
    expect(groupSessions(sessions, 'PINNED')[0].sessions[0].sessionId).toBe('c');
    expect(
      groupSessions(sessions, 'gpt-5').flatMap((g) => g.sessions.map((s) => s.sessionId)),
    ).toEqual(['d']);
    expect(groupSessions(sessions, 'scratch')[0].sessions[0].sessionId).toBe('e');
    expect(groupSessions(sessions, 'nothing matches')).toEqual([]);
  });

  it('knows which sessions are Leads', () => {
    expect([...leadSessionIds(sessions)]).toEqual(['a']);
  });

  it('lists the PC Box newest deposit first', () => {
    expect(archivedSessions(sessions).map((s) => s.sessionId)).toEqual(['f', 'g']);
  });
});

describe('per-device preferences', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('read as the default without storage', () => {
    expect(readBoolPref('pixel-agents.battleLog', true)).toBe(true);
    writeBoolPref('pixel-agents.battleLog', false); // no-op, no throw
  });

  it('round-trip through localStorage', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    });
    writeBoolPref('pixel-agents.showConnections', false);
    expect(readBoolPref('pixel-agents.showConnections', true)).toBe(false);
    writeBoolPref('pixel-agents.showConnections', true);
    expect(readBoolPref('pixel-agents.showConnections', false)).toBe(true);
  });

  it('survive storage that throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readBoolPref('k', true)).toBe(true);
    expect(() => writeBoolPref('k', false)).not.toThrow();
  });
});
