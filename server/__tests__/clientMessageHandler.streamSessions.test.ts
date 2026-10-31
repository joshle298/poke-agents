import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConductorSessionSummary } from '../../core/src/messages.js';
import type { AgentEventSink, StreamProvider, StreamSessionInfo } from '../../core/src/provider.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { type ClientMessageContext, handleClientMessage } from '../src/clientMessageHandler.js';
import { readConfig } from '../src/configPersistence.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { isAllowedExternalUrl } from '../src/streamSessionMessages.js';

type Message = Record<string, unknown>;

/** Let async replies (provider promises, hooks status checks) land. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

const SCOPE = { creator: 'me' as const, activeWithinHours: 6, showIdle: true, maxSessions: 24 };

function summary(sessionId: string): ConductorSessionSummary {
  return {
    sessionId,
    label: sessionId,
    workspaceId: 'w',
    workspaceName: 'Workspace',
    status: 'idle',
    hidden: false,
  };
}

function fakeConductor(overrides: Partial<StreamProvider> = {}): StreamProvider {
  return {
    kind: 'stream',
    id: 'conductor',
    displayName: 'Conductor',
    protocolVersion: 1,
    formatToolStatus: (toolName: string) => `Using ${toolName}`,
    permissionExemptTools: new Set<string>(),
    subagentToolNames: new Set(['Task', 'Agent']),
    readingTools: new Set(['Read', 'Monitor', 'ToolSearch']),
    start: async () => {},
    stop: async () => {},
    onDismiss: vi.fn(),
    setSessionHidden: vi.fn(),
    setSessionPinned: vi.fn(),
    setScope: vi.fn(),
    setFocus: vi.fn(),
    listSessions: vi.fn(() => [summary('s1'), summary('elsewhere')]),
    getSessionDetail: vi.fn(async () => ({
      prompt: 'Fix the flaky test',
      entries: [
        { role: 'user' as const, text: 'Fix the flaky test', at: 1 },
        { role: 'peerIn' as const, text: 'Status?', at: 2, peerSessionId: 's2', peerLabel: 'Lead' },
        { role: 'peerOut' as const, text: 'Done', at: 3, peerSessionId: 'gone' },
      ],
      truncated: true,
    })),
    sendMessage: vi.fn(async () => {}),
    stopSession: vi.fn(async () => {}),
    archiveSession: vi.fn(async () => {}),
    restoreSession: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('clientMessageHandler: stream sessions (Conductor)', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let provider: StreamProvider;
  let sink: AgentEventSink;
  let sent: Message[];
  let openExternal: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;

  function ctx(overrides: Partial<ClientMessageContext> = {}): ClientMessageContext {
    return { store, runtime, cache: null, privileged: true, openExternal, ...overrides };
  }

  function send(msg: Message, context: ClientMessageContext = ctx()): void {
    handleClientMessage(msg, (m) => sent.push(m), context);
  }

  function ofType(type: string): Message[] {
    return sent.filter((m) => m.type === type);
  }

  function adopt(sessionId: string, extra: Partial<StreamSessionInfo> = {}): number {
    sink.upsertSession({ sessionId, label: sessionId, initialStatus: 'waiting', ...extra });
    return runtime.streamDriver('conductor')!.agentIdFor(sessionId)!;
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-stream-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    runtime = new AgentRuntime(store, claudeProvider);
    provider = fakeConductor();
    sink = runtime.attachStreamProvider(provider);
    openExternal = vi.fn(async () => {});
    sent = [];
  });

  afterEach(() => {
    runtime.dispose();
    store.dispose();
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // ── Handshake ─────────────────────────────────────────────────

  describe('webviewReady', () => {
    it('advertises the union of active providers and which ones are active', () => {
      send({ type: 'webviewReady' });
      const caps = ofType('providerCapabilities')[0];
      expect(caps.activeProviders).toEqual(['claude', 'conductor']);
      expect(caps.readingTools).toEqual(
        expect.arrayContaining([...claudeProvider.readingTools, 'Monitor', 'ToolSearch']),
      );
      expect(new Set(caps.readingTools as string[]).size).toBe(
        (caps.readingTools as string[]).length,
      );
    });

    it('without Claude: no hooks status, no consent ask, no Claude tool sets', async () => {
      send({ type: 'webviewReady' }, ctx({ hookProviders: [] }));
      await settle();
      const caps = ofType('providerCapabilities')[0];
      expect(caps.activeProviders).toEqual(['conductor']);
      expect(caps.readingTools).toEqual(['Read', 'Monitor', 'ToolSearch']);
      expect(ofType('hooksStatus')).toEqual([]);
      expect(ofType('hooksConsentRequest')).toEqual([]);
    });

    it('refuses to install Claude hooks for an office without Claude', async () => {
      const onSetHooksEnabled = vi.fn();
      send(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
        ctx({ hookProviders: [], onSetHooksEnabled }),
      );
      send(
        { type: 'hooksConsentResponse', providerId: 'claude', choice: 'install' },
        ctx({ hookProviders: [], onSetHooksEnabled }),
      );
      await settle();
      expect(onSetHooksEnabled).not.toHaveBeenCalled();
      expect(readConfig().hooksConsent).toEqual({});
    });

    it('replays agent details and the provider state after the layout', () => {
      sink.setStatus({ state: 'connected', scope: SCOPE });
      sink.sessionsChanged([summary('s1')]);
      const a = adopt('s1', { details: { repo: 'hue-run/fern' } });
      const b = adopt('s2', { leadSessionId: 's1' });

      send({ type: 'webviewReady' });
      const types = sent.map((m) => m.type);
      const layoutAt = types.indexOf('layoutLoaded');
      expect(types.indexOf('agentDetails')).toBeGreaterThan(layoutAt);
      expect(types.indexOf('conductorStatus')).toBeGreaterThan(layoutAt);
      expect(types.indexOf('agentLinks')).toBeGreaterThan(layoutAt);
      expect(ofType('agentDetails')).toContainEqual(
        expect.objectContaining({ id: a, repo: 'hue-run/fern', conductorSessionId: 's1' }),
      );
      expect(ofType('conductorSessions')).toEqual([
        { type: 'conductorSessions', sessions: [{ ...summary('s1'), agentId: a }] },
      ]);
      expect(ofType('agentLinks')[0]).toEqual({
        type: 'agentLinks',
        links: [expect.objectContaining({ fromId: a, toId: b, kind: 'spawned' })],
      });
      // Stream agents are not Claude transcripts: nothing to restore.
      expect(ofType('existingAgents')[0].agents).toEqual([a, b]);
    });
  });

  // ── Pokédex ───────────────────────────────────────────────────

  describe('requestSessionDetail', () => {
    it('answers with the provider detail, peers mapped to agents in the office', async () => {
      const id = adopt('s1');
      const peer = adopt('s2');
      send({ type: 'requestSessionDetail', id });
      await settle();

      expect(provider.setFocus).toHaveBeenCalledWith(['s1']);
      expect(provider.getSessionDetail).toHaveBeenCalledWith('s1');
      expect(ofType('sessionDetail')).toEqual([
        {
          type: 'sessionDetail',
          id,
          prompt: 'Fix the flaky test',
          entries: [
            { role: 'user', text: 'Fix the flaky test', at: 1, peerId: undefined },
            { role: 'peerIn', text: 'Status?', at: 2, peerId: peer, peerLabel: 'Lead' },
            { role: 'peerOut', text: 'Done', at: 3, peerId: undefined },
          ],
          truncated: true,
        },
      ]);
    });

    it('answers an agent no provider owns with an empty detail', async () => {
      send({ type: 'requestSessionDetail', id: 404 });
      await settle();
      expect(ofType('sessionDetail')).toEqual([{ type: 'sessionDetail', id: 404, entries: [] }]);
    });
  });

  // ── Actions ───────────────────────────────────────────────────

  describe('actions', () => {
    it('sendSessionMessage sends to the agent session and reports success', async () => {
      const id = adopt('s1');
      send({ type: 'sendSessionMessage', id, text: 'continue' });
      await settle();
      expect(provider.sendMessage).toHaveBeenCalledWith('s1', 'continue');
      expect(ofType('conductorActionResult')).toEqual([
        {
          type: 'conductorActionResult',
          action: 'sendSessionMessage',
          id,
          ok: true,
          message: undefined,
        },
      ]);
    });

    it('reports a provider refusal with its message', async () => {
      provider.stopSession = vi.fn(async () => {
        throw new Error('Conductor refused: no permission');
      });
      const id = adopt('s1');
      send({ type: 'stopSession', id });
      await settle();
      expect(ofType('conductorActionResult')).toEqual([
        {
          type: 'conductorActionResult',
          action: 'stopSession',
          id,
          ok: false,
          message: 'Conductor refused: no permission',
        },
      ]);
    });

    it('refuses an empty message and an agent that is not a session, calling nothing', async () => {
      const id = adopt('s1');
      send({ type: 'sendSessionMessage', id, text: '   ' });
      send({ type: 'sendSessionMessage', id: 999, text: 'hi' });
      await settle();
      expect(provider.sendMessage).not.toHaveBeenCalled();
      expect(ofType('conductorActionResult').map((m) => [m.ok, m.message])).toEqual([
        [false, 'Type a message first.'],
        [false, 'This agent is not a Conductor session.'],
      ]);
    });

    it('archives and restores by session id, naming the agent when it is in the office', async () => {
      const id = adopt('s1');
      send({ type: 'archiveSession', sessionId: 's1' });
      send({ type: 'restoreSession', sessionId: 'archived-one' });
      await settle();
      expect(provider.archiveSession).toHaveBeenCalledWith('s1');
      expect(provider.restoreSession).toHaveBeenCalledWith('archived-one');
      expect(ofType('conductorActionResult')).toEqual([
        {
          type: 'conductorActionResult',
          action: 'archiveSession',
          id,
          ok: true,
          message: undefined,
        },
        {
          type: 'conductorActionResult',
          action: 'restoreSession',
          id: undefined,
          ok: true,
          message: undefined,
        },
      ]);
    });

    it('rejects a malformed session id', async () => {
      send({ type: 'archiveSession', sessionId: '../../etc' });
      send({ type: 'setSessionHidden', sessionId: 42, hidden: true });
      await settle();
      expect(provider.archiveSession).not.toHaveBeenCalled();
      expect(provider.setSessionHidden).not.toHaveBeenCalled();
      expect(ofType('conductorActionResult').every((m) => m.ok === false)).toBe(true);
    });

    it('hides and pins sessions', async () => {
      send({ type: 'setSessionHidden', sessionId: 's1', hidden: true });
      send({ type: 'setSessionPinned', sessionId: 's1', pinned: false });
      await settle();
      expect(provider.setSessionHidden).toHaveBeenCalledWith('s1', true);
      expect(provider.setSessionPinned).toHaveBeenCalledWith('s1', false);
      expect(ofType('conductorActionResult').map((m) => [m.action, m.ok])).toEqual([
        ['setSessionHidden', true],
        ['setSessionPinned', true],
      ]);
    });

    it('says so when the provider lacks a control', async () => {
      delete provider.setSessionPinned;
      send({ type: 'setSessionPinned', sessionId: 's1', pinned: true });
      await settle();
      expect(ofType('conductorActionResult')).toEqual([
        {
          type: 'conductorActionResult',
          action: 'setSessionPinned',
          id: undefined,
          ok: false,
          message: 'Conductor does not support this.',
        },
      ]);
    });

    it('applies a valid scope and refuses a malformed one', async () => {
      send({ type: 'setConductorScope', scope: { ...SCOPE, creator: 'all' } });
      send({ type: 'setConductorScope', scope: { ...SCOPE, creator: 'everyone' } });
      send({ type: 'setConductorScope', scope: { ...SCOPE, maxSessions: 0 } });
      send({ type: 'setConductorScope', scope: { ...SCOPE, activeWithinHours: -1 } });
      await settle();
      expect(provider.setScope).toHaveBeenCalledTimes(1);
      expect(provider.setScope).toHaveBeenCalledWith({ ...SCOPE, creator: 'all' });
      // Refusals answer at once; the applied scope answers when the provider settles.
      expect(ofType('conductorActionResult').map((m) => m.ok)).toEqual([false, false, false, true]);
    });

    it('lists every session in scope with agent ids for those in the office', () => {
      const id = adopt('s1');
      send({ type: 'requestConductorSessions' });
      expect(ofType('conductorSessions')).toEqual([
        {
          type: 'conductorSessions',
          sessions: [{ ...summary('s1'), agentId: id }, summary('elsewhere')],
        },
      ]);
    });

    it('answers when Conductor is off', async () => {
      runtime.dispose();
      runtime = new AgentRuntime(store, claudeProvider);
      send({ type: 'setSessionHidden', sessionId: 's1', hidden: true });
      send({ type: 'requestConductorSessions' });
      await settle();
      expect(ofType('conductorActionResult')[0]).toMatchObject({
        ok: false,
        message: 'Conductor is not enabled on this server.',
      });
      expect(ofType('conductorSessions')).toEqual([{ type: 'conductorSessions', sessions: [] }]);
    });

    it('closeAgent on a session hides it through the provider', () => {
      const id = adopt('s1');
      send({ type: 'closeAgent', id });
      expect(provider.onDismiss).toHaveBeenCalledWith('s1');
      expect(store.has(id)).toBe(false);
    });
  });

  // ── Deep links ────────────────────────────────────────────────

  describe('openExternal', () => {
    it('opens a Conductor deep link on the host', async () => {
      send({ type: 'openExternal', url: 'conductor://workspace?id=w1&session=s1' });
      await settle();
      expect(openExternal).toHaveBeenCalledWith('conductor://workspace?id=w1&session=s1');
      expect(ofType('conductorActionResult')).toEqual([
        {
          type: 'conductorActionResult',
          action: 'openExternal',
          id: undefined,
          ok: true,
          message: undefined,
        },
      ]);
    });

    it('refuses anything else without touching the host', async () => {
      for (const url of [
        'https://example.com',
        'conductor://evil?id=1',
        'file:///etc/passwd',
        'javascript:alert(1)',
        'conductor://workspace?id=a b',
        42,
      ]) {
        send({ type: 'openExternal', url });
      }
      await settle();
      expect(openExternal).not.toHaveBeenCalled();
      expect(ofType('conductorActionResult').every((m) => m.ok === false)).toBe(true);
    });

    it('reports a host without a link opener', async () => {
      send(
        { type: 'openExternal', url: 'conductor://workspace?id=w1' },
        ctx({ openExternal: undefined }),
      );
      await settle();
      expect(ofType('conductorActionResult')[0]).toMatchObject({ ok: false });
    });

    it('validates scheme, host and shape', () => {
      expect(isAllowedExternalUrl('conductor://workspace?id=w&session=s')).toBe(true);
      expect(isAllowedExternalUrl('conductor-dev://workspace?id=w')).toBe(true);
      expect(isAllowedExternalUrl('conductorx://workspace?id=w')).toBe(false);
      expect(isAllowedExternalUrl('conductor.dev://workspace')).toBe(false);
      expect(isAllowedExternalUrl('conductor://user:pw@workspace?id=w')).toBe(false);
      expect(isAllowedExternalUrl('conductor://workspace:8080?id=w')).toBe(false);
      expect(isAllowedExternalUrl('conductor://workspace?id=w\n--flag')).toBe(false);
      expect(isAllowedExternalUrl(`conductor://workspace?id=${'w'.repeat(3000)}`)).toBe(false);
    });
  });

  // ── Theme ─────────────────────────────────────────────────────

  describe('setPokemonTheme', () => {
    it('defaults on, persists, and tells every office', () => {
      send({ type: 'webviewReady' });
      expect(ofType('settingsLoaded')[0].pokemonTheme).toBe(true);

      sent = [];
      send({ type: 'setPokemonTheme', enabled: false });
      expect(readConfig().standalone.pokemonTheme).toBe(false);
      expect(readConfig().vscode.pokemonTheme).toBe(true);

      const broadcasts: Message[] = [];
      store.on('broadcast', (m) => broadcasts.push(m));
      send({ type: 'setPokemonTheme', enabled: true });
      expect(broadcasts).toEqual([{ type: 'pokemonThemeUpdated', enabled: true }]);
    });
  });

  // ── Read-only offices ─────────────────────────────────────────

  describe('read-only clients', () => {
    it('refuses every session action, calls nothing, and settles the control', async () => {
      const id = adopt('s1');
      sink.setStatus({ state: 'connected', scope: SCOPE });
      const readOnly = ctx({ privileged: false });
      for (const msg of [
        { type: 'sendSessionMessage', id, text: 'hi' },
        { type: 'stopSession', id },
        { type: 'archiveSession', sessionId: 's1' },
        { type: 'restoreSession', sessionId: 's1' },
        { type: 'setSessionHidden', sessionId: 's1', hidden: true },
        { type: 'setSessionPinned', sessionId: 's1', pinned: true },
        { type: 'setConductorScope', scope: SCOPE },
        { type: 'openExternal', url: 'conductor://workspace?id=w' },
        { type: 'requestSessionDetail', id },
        { type: 'requestConductorSessions' },
        { type: 'setPokemonTheme', enabled: false },
      ]) {
        send(msg, readOnly);
      }
      await settle();

      for (const call of [
        provider.sendMessage,
        provider.stopSession,
        provider.archiveSession,
        provider.restoreSession,
        provider.setSessionHidden,
        provider.setSessionPinned,
        provider.setScope,
        provider.getSessionDetail,
        openExternal,
      ]) {
        expect(call).not.toHaveBeenCalled();
      }
      expect(readConfig().standalone.pokemonTheme).toBe(true);
      expect(ofType('conductorActionResult')).toHaveLength(8);
      expect(ofType('conductorActionResult').every((m) => m.ok === false)).toBe(true);
      // The optimistic toggles get the truth back.
      expect(ofType('conductorSessions')).toHaveLength(2);
      expect(ofType('conductorStatus')).toHaveLength(1);
      expect(ofType('settingsLoaded')[0]).toMatchObject({ pokemonTheme: true });
      expect(ofType('sessionDetail')).toEqual([]);
    });
  });
});
