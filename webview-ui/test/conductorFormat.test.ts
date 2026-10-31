import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConductorSessionSummary, ConductorStatus } from '../../core/src/messages.js';
import {
  agoText,
  apiKeyFromText,
  authSourceText,
  canSignOut,
  CONDUCTOR_CLI_LOGIN_COMMAND,
  conductorStatusLine,
  envKeyRejected,
  isConductorDeepLink,
  keyStorageNote,
  maskedKeyHint,
  modelLabel,
  needsSignIn,
  NO_LIMIT_NOTE,
  pasteBlockedMessage,
  safeHttpsUrl,
  shortAge,
  signOutConfirmText,
  splitConnectedMessage,
  splitNameTail,
  windowLabel,
  windowOptions,
  workspaceLabel,
} from '../src/conductor/format.js';
import { readBoolPref, writeBoolPref } from '../src/conductor/preferences.js';
import { archivedSessions, groupSessions, leadSessionIds } from '../src/conductor/sessionsView.js';
import { CONDUCTOR_SCOPE_WINDOW_HOURS } from '../src/constants.js';
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
    expect(conductorStatusLine(status({ state: 'authRequired' }), now)).toBe(
      'Not connected to Conductor. Connect with an API key.',
    );
    expect(conductorStatusLine(status({ state: 'unauthorized' }), now)).toBe(
      'Conductor rejected the API key. Connect with a new one.',
    );
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
    expect(windowLabel(0)).toBe('Never');
    expect(windowLabel(0.25)).toBe('15 min');
    expect(windowLabel(0.5)).toBe('30 min');
    expect(windowLabel(1)).toBe('1 h');
    expect(windowLabel(24)).toBe('24 h');
    expect(windowLabel(72)).toBe('3 days');
    expect(windowLabel(720)).toBe('30 days');
    expect(windowLabel(36)).toBe('36 h');
    expect(windowLabel(2.4)).toBe('144 min');
  });

  it('offers "Hide sessions idle longer than" from 15 min to Never (last), and a value the server applied', () => {
    const labels = (current?: number) =>
      windowOptions(CONDUCTOR_SCOPE_WINDOW_HOURS, current).map((o) => o.label);
    expect(labels()).toEqual(['15 min', '30 min', '1 h', '6 h', '24 h', '3 days', 'Never']);
    expect(windowOptions(CONDUCTOR_SCOPE_WINDOW_HOURS, 0).at(-1)).toEqual({
      value: 0,
      label: 'Never',
    });
    expect(windowOptions(CONDUCTOR_SCOPE_WINDOW_HOURS, 0.25)[0]).toEqual({
      value: 0.25,
      label: '15 min',
    });
    // A window kept from an older build or another office stays visible.
    expect(labels(12)).toEqual([
      '15 min',
      '30 min',
      '1 h',
      '6 h',
      '12 h',
      '24 h',
      '3 days',
      'Never',
    ]);
    expect(labels(720)).toEqual([
      '15 min',
      '30 min',
      '1 h',
      '6 h',
      '24 h',
      '3 days',
      '30 days',
      'Never',
    ]);
    expect(labels(-1)).toEqual(['15 min', '30 min', '1 h', '6 h', '24 h', '3 days', 'Never']);
  });

  it('says that Never still stops at the 30-day window', () => {
    expect(NO_LIMIT_NOTE).toContain('30 days');
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

  it('a session continued with another model (Switch model) is not a Lead for it', () => {
    const list = [
      session({ sessionId: 'orig', label: 'Write migration' }),
      session({ sessionId: 'next', leadSessionId: 'orig', handoff: true }),
    ];
    expect([...leadSessionIds(list)]).toEqual([]);
    // A real spawn from it still makes it one.
    expect([
      ...leadSessionIds([...list, session({ sessionId: 'kid', leadSessionId: 'orig' })]),
    ]).toEqual(['orig']);
  });

  it('lists archived sessions newest first', () => {
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

describe('the Connect to Conductor card', () => {
  const KEY = `pa_${'fake'.repeat(11)}`;
  const now = 1_000_000;

  it('takes a pasted key trimmed, and only when it has a key’s shape', () => {
    expect(apiKeyFromText(`  ${KEY}\n`)).toBe(KEY);
    expect(apiKeyFromText('x'.repeat(20))).toBe('x'.repeat(20));
    for (const bad of ['', 'short', `${KEY} ${KEY}`, `${KEY}"`, 'x'.repeat(201)]) {
      expect(apiKeyFromText(bad)).toBeNull();
    }
  });

  it('lets a key pasted twice through for the server to try one copy', () => {
    // 47 characters twice is still key-shaped; 120 twice is too long for one key.
    const long = `pa_${'y'.repeat(117)}`;
    expect(apiKeyFromText(`${KEY}${KEY}`)).toBe(`${KEY}${KEY}`);
    expect(apiKeyFromText(` ${long}${long}\n`)).toBe(`${long}${long}`);
    expect(apiKeyFromText(`${long}${long}x`)).toBeNull();
  });

  it('never tells the office to restart for a sign-in it can fix itself', () => {
    // The server's message mentions CONDUCTOR_API_KEY for the terminal; the
    // office points at its own Connect card instead.
    for (const state of ['authRequired', 'unauthorized'] as const) {
      const line = conductorStatusLine(
        status({ state, message: 'Server text about CONDUCTOR_API_KEY, then restart.' }),
        now,
      );
      expect(line).toContain('Connect');
      expect(line).not.toMatch(/restart|CONDUCTOR_API_KEY|conductor auth login/i);
    }
  });

  it('says to update the variable when Conductor rejects a key from the environment', () => {
    const rejected = status({ state: 'unauthorized', authSource: 'env' });
    expect(envKeyRejected(rejected)).toBe(true);
    expect(conductorStatusLine(rejected, now)).toBe(
      'Conductor rejected the key in CONDUCTOR_API_KEY. Update it, then restart Poke Agents.',
    );
    // Named after the variable the key came from.
    expect(
      conductorStatusLine(
        status({ state: 'unauthorized', authSource: 'env', authEnv: 'CONDUCTOR_API_TOKEN' }),
        now,
      ),
    ).toBe(
      'Conductor rejected the key in CONDUCTOR_API_TOKEN. Update it, then restart Poke Agents.',
    );
    for (const authSource of ['app', 'cli', 'session'] as const) {
      expect(envKeyRejected(status({ state: 'unauthorized', authSource }))).toBe(false);
    }
    expect(envKeyRejected(status({ state: 'connected', authSource: 'env' }))).toBe(false);
  });

  it('says where the key in use came from, and where a pasted one is kept', () => {
    expect(authSourceText(status({ authSource: 'env' }))).toBe(
      'Signed in with CONDUCTOR_API_KEY from the environment.',
    );
    expect(authSourceText(status({ authSource: 'env', authEnv: 'CONDUCTOR_API_TOKEN' }))).toBe(
      'Signed in with CONDUCTOR_API_TOKEN from the environment.',
    );
    expect(authSourceText(status({ authSource: 'cli' }))).toBe(
      'Signed in through the Conductor CLI.',
    );
    expect(authSourceText(status({}))).toBeNull();
    expect(authSourceText(null)).toBeNull();
    // "Session" means a Conductor session in this product: say how long.
    for (const text of [
      authSourceText(status({ authSource: 'session', keyStorage: 'session' })),
      authSourceText(status({ authSource: 'session', keyStorage: 'keychain' })),
      keyStorageNote('session'),
    ]) {
      expect(text).toMatch(/until (Poke Agents|it) quits/);
      expect(text).not.toMatch(/session/i);
    }
    // Off a Mac the variable keeps it; a Mac app opened from Finder can't take one.
    expect(authSourceText(status({ authSource: 'session', keyStorage: 'session' }))).toContain(
      'Set CONDUCTOR_API_KEY',
    );
    expect(keyStorageNote('session')).toContain('Set CONDUCTOR_API_KEY');
    const refusedOnMac = authSourceText(status({ authSource: 'session', keyStorage: 'keychain' }));
    expect(refusedOnMac).toContain('Connect again next time.');
    expect(refusedOnMac).not.toContain('CONDUCTOR_API_KEY');
  });

  it('says plainly that apps you run can read the Keychain item', () => {
    for (const text of [
      authSourceText(status({ authSource: 'app' })),
      keyStorageNote('keychain'),
    ]) {
      expect(text).toContain('macOS Keychain');
      expect(text).toContain('apps you run can read it without asking');
    }
  });

  it('confirms Sign out honestly about the Conductor CLI on a Mac', () => {
    const mac = signOutConfirmText(status({ authSource: 'app', keyStorage: 'keychain' }));
    expect(mac).toContain('If the Conductor CLI is signed in, the office switches to that sign-in');
    expect(mac).toContain('macOS may ask to allow Keychain access');
    expect(mac).not.toContain('you need an API key');
    const elsewhere = signOutConfirmText(status({ authSource: 'session', keyStorage: 'session' }));
    expect(elsewhere).toBe(
      'Poke Agents forgets the API key, and its sessions leave the office. To connect again you need an API key.',
    );
  });

  it('masks a clipboard key to its prefix and last four characters', () => {
    expect(maskedKeyHint(`pakey_${'x'.repeat(39)}wxyz`)).toBe('pakey_…wxyz');
    expect(maskedKeyHint(`${'X'.repeat(30)}abcd`)).toBe('…abcd');
  });

  it('titles the empty office with the reply’s first line', () => {
    expect(splitConnectedMessage('Connected as a@b.c')).toEqual({ headline: 'Connected as a@b.c' });
    expect(splitConnectedMessage('Connected as Dr. Lee\nCouldn’t save it.')).toEqual({
      headline: 'Connected as Dr. Lee',
      note: 'Couldn’t save it.',
    });
    expect(splitConnectedMessage(undefined)).toEqual({ headline: 'Connected to Conductor' });
  });

  it('says how to paste when the browser blocks the clipboard', () => {
    expect(pasteBlockedMessage('MacIntel')).toBe('Clipboard access was blocked. Paste with Cmd+V.');
    expect(pasteBlockedMessage('Linux x86_64')).toBe(
      'Clipboard access was blocked. Paste with Ctrl+V.',
    );
  });

  it('offers Sign out only for a key Poke Agents keeps', () => {
    expect(canSignOut(status({ authSource: 'app' }))).toBe(true);
    expect(canSignOut(status({ authSource: 'session' }))).toBe(true);
    expect(canSignOut(status({ authSource: 'cli' }))).toBe(false);
    expect(canSignOut(status({ authSource: 'env' }))).toBe(false);
    expect(canSignOut(status({}))).toBe(false);
    expect(canSignOut(null)).toBe(false);
  });

  it('gives the CLI path inside Conductor.app, quoted for its space', () => {
    expect(CONDUCTOR_CLI_LOGIN_COMMAND).toBe(
      '"$HOME/Library/Application Support/com.conductor.app/bin/conductor" auth login',
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

describe('splitNameTail', () => {
  it('keeps the end of a long slug in view, whole segments where they fit', () => {
    expect(splitNameTail('recorder-platform-review-1')).toEqual({
      head: 'recorder-platform-',
      tail: 'review-1',
    });
    expect(splitNameTail('recorder-platform-review-2').tail).toBe('review-2');
    expect(splitNameTail('feature/very_long_branch_name.v12').tail).toBe('name.v12');
  });

  it('falls back to the last few characters when the last segment is long', () => {
    expect(splitNameTail('workspacewithoutanyseparators')).toEqual({
      head: 'workspacewithoutanysepa',
      tail: 'rators',
    });
  });

  it('leaves short names and titles whole', () => {
    expect(splitNameTail('short-name')).toEqual({ head: 'short-name', tail: '' });
    expect(splitNameTail('Google Files baseline measurement')).toEqual({
      head: 'Google Files baseline measurement',
      tail: '',
    });
  });
});
