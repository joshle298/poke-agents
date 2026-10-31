import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConductorSessionSummary, ConductorStatus } from '../../core/src/messages.js';
import { updateNoticeFor } from '../src/changelogData.js';
import {
  agoText,
  conductorStatusLine,
  isConductorDeepLink,
  modelLabel,
  needsSignIn,
  safeHttpsUrl,
  shortAge,
  signInSteps,
  windowLabel,
  workspaceLabel,
} from '../src/conductor/format.js';
import { readBoolPref, writeBoolPref } from '../src/conductor/preferences.js';
import { archivedSessions, groupSessions, leadSessionIds } from '../src/conductor/sessionsView.js';
import { isDesktopAppUserAgent, parseDesktopCommand } from '../src/desktopApp.js';

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
    expect(windowLabel(0)).toBe('All');
    expect(windowLabel(24)).toBe('24h');
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

describe('signInSteps', () => {
  const text = (desktopApp: boolean, canReconnect = false) =>
    signInSteps(desktopApp, canReconnect).map(
      (step) => `${step.lead}${step.accent ?? ''}${step.tail ?? ''}`,
    );

  it('tells a terminal-started office to log in or set the key, then restart', () => {
    expect(text(false)).toEqual([
      'Run conductor auth login, or set CONDUCTOR_API_KEY.',
      'Restart Poke Agents.',
    ]);
  });

  it('tells the desktop app to log in from Terminal, reconnect, and allow the Keychain', () => {
    expect(text(true, true)).toEqual([
      'Run conductor auth login in Terminal.',
      'Click Reconnect. If macOS asks to use the Keychain, choose Allow.',
    ]);
    // Without the app's button (no preload), the menu item does the same.
    expect(text(true, false)[1]).toBe(
      'Choose Poke Agents > Reconnect to Conductor. If macOS asks to use the Keychain, choose Allow.',
    );
    // An app opened from Finder never sees the shell's environment.
    expect([...text(true, true), ...text(true, false)].join(' ')).not.toContain(
      'CONDUCTOR_API_KEY',
    );
  });

  it('marks the login command as copyable and nothing else', () => {
    for (const desktopApp of [false, true]) {
      const copyable = signInSteps(desktopApp, true).filter((step) => step.copy);
      expect(copyable.map((step) => step.accent)).toEqual(['conductor auth login']);
    }
  });
});

describe('conductorStatusLine in the desktop app', () => {
  const now = 1_000_000;
  const serverMessage =
    'Sign in with `conductor auth login` or set CONDUCTOR_API_KEY, then restart.';

  it('words both sign-in states for the app, whatever the server says', () => {
    const missing = conductorStatusLine(
      status({ state: 'authRequired', message: serverMessage }),
      now,
      true,
    );
    const rejected = conductorStatusLine(
      status({ state: 'unauthorized', message: 'Conductor rejected the API key. Restart.' }),
      now,
      true,
    );
    expect(missing).toBe(
      'No Conductor sign-in found. Run `conductor auth login` in Terminal, then choose Poke Agents > Reconnect to Conductor.',
    );
    expect(rejected).toBe(
      'Conductor rejected the sign-in. Run `conductor auth login` in Terminal, then choose Poke Agents > Reconnect to Conductor.',
    );
    for (const line of [missing, rejected]) {
      expect(line).not.toContain('CONDUCTOR_API_KEY');
      expect(line).not.toMatch(/restart/i);
    }
  });

  it('leaves the browser wording and the other states alone', () => {
    expect(
      conductorStatusLine(status({ state: 'authRequired', message: serverMessage }), now, false),
    ).toBe(serverMessage);
    expect(conductorStatusLine(status({ state: 'unreachable' }), now, true)).toContain(
      "Can't reach",
    );
    expect(conductorStatusLine(status({ lastSyncAt: now - 42_000 }), now, true)).toBe(
      'Conductor · synced 42s ago',
    );
  });
});

describe('parseDesktopCommand', () => {
  it('accepts the app’s two commands', () => {
    expect(parseDesktopCommand({ type: 'openSession', agentId: 7 })).toEqual({
      type: 'openSession',
      agentId: 7,
    });
    expect(parseDesktopCommand({ type: 'openSettings' })).toEqual({ type: 'openSettings' });
  });

  it('rejects anything else', () => {
    for (const raw of [
      null,
      'openSettings',
      { type: 'openSession' },
      { type: 'openSession', agentId: '7' },
      { type: 'openSession', agentId: 0 },
      { type: 'openSession', agentId: 1.5 },
      { type: 'reload' },
    ]) {
      expect(parseDesktopCommand(raw)).toBeNull();
    }
  });
});

describe('updateNoticeFor', () => {
  it('announces an upgrade, records a fresh install silently, and waits for settings', () => {
    expect(updateNoticeFor('0.2.0', '0.1')).toBe('show');
    expect(updateNoticeFor('0.1.3', '0.1')).toBe('none');
    expect(updateNoticeFor('0.1.0', '')).toBe('record');
    expect(updateNoticeFor('', '')).toBe('none');
  });
});

describe('isDesktopAppUserAgent', () => {
  it('recognizes the product token the desktop app appends', () => {
    expect(
      isDesktopAppUserAgent(
        'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/142.0 Electron/45.2.1 Safari/537.36 PokeAgentsDesktop/0.1.0',
      ),
    ).toBe(true);
    expect(
      isDesktopAppUserAgent(
        'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/142.0 Safari/537.36',
      ),
    ).toBe(false);
    expect(isDesktopAppUserAgent('Mozilla/5.0 NotPokeAgentsDesktop/1')).toBe(false);
  });
});
