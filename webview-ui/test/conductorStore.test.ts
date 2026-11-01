import { beforeEach, describe, expect, it } from 'vitest';

import type { PokemonSpeciesLoaded, ServerMessage } from '../../core/src/messages.js';
import {
  agentBattleName,
  ConductorStore,
  connectAnswer,
  crossesEvolutionLevel,
  currentActivity,
} from '../src/conductor/conductorStore.js';
import { BATTLE_LOG_CAPACITY, TOAST_MAX_KEPT } from '../src/constants.js';

function species(dex: number, name: string, shiny = false): PokemonSpeciesLoaded {
  return {
    type: 'pokemonSpeciesLoaded',
    dex,
    shiny,
    name,
    shadowSize: 1,
    anims: {},
    portraits: { Normal: `/api/pokemon/${dex}/portrait/Normal.png` },
    credits: { sprite: [], portrait: [], pageUrl: '' },
  };
}

describe('ConductorStore', () => {
  let clock: number;
  let store: ConductorStore;
  const apply = (...msgs: ServerMessage[]) => msgs.forEach((m) => store.apply(m));
  const log = () => store.getState().battleLog.map((e) => e.text);

  beforeEach(() => {
    clock = 1_000_000;
    store = new ConductorStore({ now: () => clock });
  });

  describe('providers', () => {
    it('defaults to Claude only, and reads activeProviders when sent', () => {
      expect(store.getState().activeProviders).toEqual(['claude']);
      apply({
        type: 'providerCapabilities',
        readingTools: [],
        subagentToolNames: [],
        activeProviders: ['conductor'],
      });
      expect(store.getState().activeProviders).toEqual(['conductor']);
    });

    it('treats a providerCapabilities without activeProviders as an older Claude host', () => {
      apply(
        {
          type: 'providerCapabilities',
          readingTools: [],
          subagentToolNames: [],
          activeProviders: ['conductor'],
        },
        { type: 'providerCapabilities', readingTools: [], subagentToolNames: [] },
      );
      expect(store.getState().activeProviders).toEqual(['claude']);
    });
  });

  describe('agents', () => {
    it('merges agentCreated and agentDetails, leaving absent fields as they were', () => {
      apply(
        {
          type: 'agentCreated',
          id: 3,
          providerId: 'conductor',
          label: 'Fix login',
          species: 4,
          level: 5,
        },
        {
          type: 'agentDetails',
          id: 3,
          model: 'gpt-5',
          conductorWorkspaceNumber: 42,
          conductorWorkspaceName: 'login',
          externalUrl: 'conductor://workspace?id=w&session=s',
        },
        { type: 'agentDetails', id: 3, repo: 'acme/web' },
      );
      const agent = store.getState().agents[3];
      expect(agent).toMatchObject({
        providerId: 'conductor',
        label: 'Fix login',
        species: 4,
        level: 5,
        model: 'gpt-5',
        workspaceNumber: 42,
        workspaceName: 'login',
        repo: 'acme/web',
      });
      expect(store.getState().agentIds).toEqual([3]);
    });

    it('takes a teammate lead from agentCreated, and agentTeamInfo replaces it', () => {
      apply({ type: 'agentCreated', id: 2, isTeammate: true, parentAgentId: 1 });
      expect(store.getState().agents[2].leadAgentId).toBe(1);
      // Lead eviction: the server clears leadAgentId by omitting it.
      apply({ type: 'agentTeamInfo', id: 2 });
      expect(store.getState().agents[2].leadAgentId).toBeUndefined();
      apply({ type: 'agentTeamInfo', id: 1, isTeamLead: true });
      expect(store.getState().agents[1].isTeamLead).toBe(true);
    });

    it('restores existing agents with their species', () => {
      apply({
        type: 'existingAgents',
        agents: [5, 6],
        agentMeta: { '5': { species: 25, shiny: true } },
        directoryNames: {},
        externalAgents: {},
      });
      expect(store.getState().agentIds).toEqual([5, 6]);
      expect(store.getState().agents[5]).toMatchObject({ species: 25, shiny: true });
      expect(store.getState().agents[6].species).toBeUndefined();
    });

    it('forgets a closed agent but remembers its session species for the PC Box', () => {
      apply(
        { type: 'agentCreated', id: 7, species: 133 },
        { type: 'agentDetails', id: 7, conductorSessionId: 'sess-7' },
        { type: 'sessionDetail', id: 7, entries: [] },
        { type: 'agentClosed', id: 7 },
      );
      const state = store.getState();
      expect(state.agents[7]).toBeUndefined();
      expect(state.agentIds).toEqual([]);
      expect(state.sessionDetails[7]).toBeUndefined();
      expect(state.sessionSpecies['sess-7']).toEqual({ species: 133, shiny: false });
    });

    it('tracks the running tool as the current activity', () => {
      apply(
        { type: 'agentToolStart', id: 1, toolId: 't1', status: 'Reading a.ts', toolName: 'Read' },
        {
          type: 'agentToolStart',
          id: 1,
          toolId: 't2',
          status: 'Running npm test',
          toolName: 'Bash',
        },
      );
      expect(currentActivity(store.getState().agents[1])).toBe('Running npm test');
      apply({ type: 'agentToolDone', id: 1, toolId: 't2' });
      expect(currentActivity(store.getState().agents[1])).toBe('Reading a.ts');
      apply({ type: 'agentToolsClear', id: 1 });
      expect(currentActivity(store.getState().agents[1])).toBeNull();
    });

    it('tracks permission until cleared or the turn ends', () => {
      apply({ type: 'agentToolPermission', id: 1 });
      expect(store.getState().agents[1].permission).toBe(true);
      apply({ type: 'agentStatus', id: 1, status: 'active' });
      expect(store.getState().agents[1].permission).toBe(true);
      apply({ type: 'agentStatus', id: 1, status: 'waiting' });
      expect(store.getState().agents[1].permission).toBe(false);
    });

    it('keeps the error message only while errored, and awaitingInput only while waiting', () => {
      apply({ type: 'agentStatus', id: 1, status: 'error', errorMessage: 'boom' });
      expect(store.getState().agents[1]).toMatchObject({ status: 'error', errorMessage: 'boom' });
      apply({ type: 'agentStatus', id: 1, status: 'waiting', awaitingInput: true });
      expect(store.getState().agents[1]).toMatchObject({ awaitingInput: true });
      expect(store.getState().agents[1].errorMessage).toBeUndefined();
      apply({ type: 'agentStatus', id: 1, status: 'active', awaitingInput: true });
      expect(store.getState().agents[1].awaitingInput).toBe(false);
    });

    it('moves lastActiveAt on live activity but not on seeding', () => {
      apply({ type: 'agentStatus', id: 1, status: 'waiting', silent: true });
      expect(store.getState().agents[1].lastActiveAt).toBeUndefined();
      clock += 5;
      apply({ type: 'agentStatus', id: 1, status: 'active' });
      expect(store.getState().agents[1].lastActiveAt).toBe(clock);
    });
  });

  describe('battle log', () => {
    beforeEach(() => {
      apply(species(25, 'Pikachu'), species(150, 'Mewtwo'), species(4, 'Charmander'));
      apply(
        { type: 'agentCreated', id: 1, label: 'Lead', species: 150, level: 30 },
        { type: 'agentCreated', id: 2, label: 'Docs', species: 25, level: 3 },
      );
    });

    it('names agents by species, falling back to their nickname', () => {
      apply({ type: 'agentCreated', id: 9, label: 'No sprite yet' });
      expect(agentBattleName(store.getState(), 2)).toBe('Pikachu');
      expect(agentBattleName(store.getState(), 9)).toBe('No sprite yet');
      expect(agentBattleName(store.getState(), 404)).toBe('Agent 404');
    });

    it('logs tool starts once per tool', () => {
      const start: ServerMessage = {
        type: 'agentToolStart',
        id: 2,
        toolId: 't1',
        status: 'Running ls',
        toolName: 'Bash',
      };
      apply(start, start);
      apply({ type: 'agentToolStart', id: 2, toolId: 't2', status: 'Editing a.ts' });
      expect(log()).toEqual(['Pikachu used Bash!', 'Pikachu used Edit!']);
    });

    it('logs a live error as fainting, once, and never a seeded one', () => {
      apply({ type: 'agentStatus', id: 1, status: 'error', silent: true });
      apply({ type: 'agentStatus', id: 2, status: 'error' });
      apply({ type: 'agentStatus', id: 2, status: 'error' });
      expect(log()).toEqual(['Pikachu fainted!']);
    });

    it('logs spawns and messages between sessions, but not watching', () => {
      apply(
        { type: 'agentMessage', fromId: 1, toId: 2, kind: 'spawned', at: 1 },
        { type: 'agentMessage', fromId: 2, toId: 1, kind: 'messaged', at: 2 },
        { type: 'agentMessage', fromId: 1, toId: 2, kind: 'watched', at: 3 },
      );
      expect(log()).toEqual(['Mewtwo sent out Pikachu!', 'Pikachu sent Mewtwo a message!']);
    });

    it('logs a species change that crosses an evolution level as an evolution', () => {
      apply(species(5, 'Charmeleon'));
      apply({ type: 'agentCreated', id: 3, species: 4, level: 15 });
      apply({ type: 'agentDetails', id: 3, level: 16 });
      apply({ type: 'agentDetails', id: 3, species: 5 });
      expect(log()).toEqual(['Charmander evolved into Charmeleon!']);
    });

    it('does not call a Lead promotion to a legendary an evolution', () => {
      apply({ type: 'agentCreated', id: 3, species: 4, level: 7 });
      apply({ type: 'agentDetails', id: 3, species: 150, level: 7 });
      expect(log()).toEqual([]);
    });

    it('keeps only the newest BATTLE_LOG_CAPACITY events', () => {
      for (let i = 0; i < BATTLE_LOG_CAPACITY + 5; i++) {
        apply({
          type: 'agentToolStart',
          id: 2,
          toolId: `t${i}`,
          status: `Running ${i}`,
          toolName: 'Bash',
        });
      }
      const entries = store.getState().battleLog;
      expect(entries).toHaveLength(BATTLE_LOG_CAPACITY);
      expect(entries[0].seq).toBeLessThan(entries[entries.length - 1].seq);
    });
  });

  describe('crossesEvolutionLevel', () => {
    it('is true only across 16 or 36', () => {
      expect(crossesEvolutionLevel(15, 16)).toBe(true);
      expect(crossesEvolutionLevel(30, 40)).toBe(true);
      expect(crossesEvolutionLevel(16, 20)).toBe(false);
      expect(crossesEvolutionLevel(undefined, 20)).toBe(false);
    });
  });

  describe('Conductor connection and actions', () => {
    it('stores status, sessions and session details', () => {
      const scope = {
        creator: 'me' as const,
        activeWithinHours: 6,
        showIdle: true,
        maxSessions: 24,
      };
      apply(
        { type: 'conductorStatus', state: 'connected', account: 'a@b.c', scope },
        {
          type: 'conductorSessions',
          sessions: [
            {
              sessionId: 's',
              label: 'L',
              workspaceId: 'w',
              workspaceName: 'W',
              status: 'idle',
              hidden: false,
            },
          ],
        },
        {
          type: 'sessionDetail',
          id: 1,
          prompt: 'Do it',
          entries: [{ role: 'user', text: 'hi', at: 1 }],
        },
      );
      const state = store.getState();
      expect(state.status?.account).toBe('a@b.c');
      expect(state.sessions).toHaveLength(1);
      expect(state.sessionDetails[1].prompt).toBe('Do it');
    });

    it('toasts sends, stops and PC moves, but only failures of visibility toggles', () => {
      apply({ type: 'agentCreated', id: 1, label: 'Lead' });
      apply(
        { type: 'conductorActionResult', action: 'sendSessionMessage', id: 1, ok: true },
        { type: 'conductorActionResult', action: 'setSessionHidden', ok: true },
        {
          type: 'conductorActionResult',
          action: 'stopSession',
          id: 1,
          ok: false,
          message: 'Session not found',
        },
      );
      const toasts = store.getState().toasts;
      expect(toasts.map((t) => [t.text, t.tone])).toEqual([
        ['Message sent to Lead', 'success'],
        ["Couldn't stop the session: Session not found", 'error'],
      ]);
      // Stamped with the store's clock: the message bar times each one from
      // when it arrived, shown or not.
      expect(toasts.map((t) => t.at)).toEqual([clock, clock]);
      expect(store.getState().actionOutcomes[1]).toMatchObject({
        action: 'stopSession',
        ok: false,
        message: 'Session not found',
      });
      store.dismissToast(toasts[0].seq);
      expect(store.getState().toasts).toHaveLength(1);
    });

    it('keeps the newest connect or sign-out answer for the Connect card and Settings', () => {
      expect(store.getState().signIn).toBeNull();
      apply({
        type: 'conductorActionResult',
        action: 'connect',
        ok: false,
        message: 'That key was rejected by Conductor.',
      });
      const rejected = store.getState().signIn;
      expect(rejected).toMatchObject({
        action: 'connect',
        ok: false,
        message: 'That key was rejected by Conductor.',
        at: clock,
      });
      // A failed connect shows on the card itself, not as a toast.
      expect(store.getState().toasts).toEqual([]);

      clock += 1_000;
      apply({
        type: 'conductorActionResult',
        action: 'connect',
        ok: true,
        message: 'Connected as dev@example.com',
      });
      const connected = store.getState().signIn;
      expect(connected).toMatchObject({ action: 'connect', ok: true, at: clock });
      expect(connected!.seq).toBeGreaterThan(rejected!.seq);
      apply(
        { type: 'conductorActionResult', action: 'disconnect', ok: true, message: 'Signed out.' },
        {
          type: 'conductorActionResult',
          action: 'disconnect',
          ok: false,
          message: "Couldn't remove the key from the Keychain.",
        },
      );
      // A connect's answer shows on the card (and titles the empty office): no toast.
      expect(store.getState().toasts.map((t) => [t.text, t.tone])).toEqual([
        ['Signed out.', 'success'],
        ["Couldn't sign out: Couldn't remove the key from the Keychain.", 'error'],
      ]);
      expect(store.getState().signIn).toMatchObject({ action: 'disconnect', ok: false });
    });

    it('answers a pending connect only with a newer connect outcome', () => {
      apply({ type: 'conductorActionResult', action: 'connect', ok: false, message: 'old' });
      const sentAfter = store.getState().signIn!.seq;
      expect(connectAnswer(store.getState().signIn, sentAfter)).toBeNull();
      apply({ type: 'conductorActionResult', action: 'disconnect', ok: true });
      expect(connectAnswer(store.getState().signIn, sentAfter)).toBeNull();
      apply({ type: 'conductorActionResult', action: 'connect', ok: true, message: 'Connected' });
      expect(connectAnswer(store.getState().signIn, sentAfter)).toMatchObject({ ok: true });
      expect(connectAnswer(null, -1)).toBeNull();
    });

    it('caps the toasts it keeps, dropping successes before errors', () => {
      for (let i = 0; i < TOAST_MAX_KEPT + 2; i++) {
        apply({ type: 'conductorActionResult', action: 'openExternal', ok: false });
      }
      expect(store.getState().toasts).toHaveLength(TOAST_MAX_KEPT);
      const failed = store.getState().toasts.map((t) => t.seq);

      // A burst of successes never pushes out an error still up: they push
      // each other out instead.
      store
        .getState()
        .toasts.slice(1)
        .forEach((t) => store.dismissToast(t.seq));
      apply({ type: 'agentCreated', id: 1, label: 'Lead' });
      for (let i = 0; i < TOAST_MAX_KEPT + 2; i++) {
        apply({ type: 'conductorActionResult', action: 'sendSessionMessage', id: 1, ok: true });
      }
      const toasts = store.getState().toasts;
      expect(toasts).toHaveLength(TOAST_MAX_KEPT);
      expect(toasts[0]).toMatchObject({ seq: failed[0], tone: 'error' });
      expect(toasts.slice(1).every((t) => t.tone === 'success')).toBe(true);
    });

    it('patches a session optimistically until the server list replaces it', () => {
      const base = { label: 'L', workspaceId: 'w', workspaceName: 'W', status: 'idle' as const };
      apply({
        type: 'conductorSessions',
        sessions: [{ ...base, sessionId: 'a', hidden: false }],
      });
      store.patchSession('a', { hidden: true, pinned: true });
      expect(store.getState().sessions?.[0]).toMatchObject({ hidden: true, pinned: true });
      // A refusal re-sends the truth.
      apply({ type: 'conductorSessions', sessions: [{ ...base, sessionId: 'a', hidden: false }] });
      expect(store.getState().sessions?.[0].hidden).toBe(false);
    });
  });

  describe('theme', () => {
    it('is on by default and when settingsLoaded omits it', () => {
      expect(store.getState().pokemonTheme).toBe(true);
      apply({
        type: 'settingsLoaded',
        soundEnabled: true,
        lastSeenVersion: '',
        extensionVersion: '0.1.0',
        watchAllSessions: false,
        alwaysShowLabels: false,
        ghostHeadlessAgents: false,
        hooksEnabled: false,
        hooksInfoShown: false,
        externalAssetDirectories: [],
        showAreas: false,
        bypassPermissions: false,
        showHostDirectories: false,
      });
      expect(store.getState().pokemonTheme).toBe(true);
    });

    it('applies the toggle at once, and the server answer wins', () => {
      store.setPokemonTheme(false);
      expect(store.getState().pokemonTheme).toBe(false);
      apply({ type: 'pokemonThemeUpdated', enabled: true });
      expect(store.getState().pokemonTheme).toBe(true);
    });
  });

  describe('chat history', () => {
    const page = (keys: string[], at0: number) =>
      keys.map((key, i) => ({ role: 'assistant' as const, text: key, at: at0 + i, key }));
    const history = () => store.getState().chatHistories[3];

    it('takes the newest page, then older pages by cursor, merged by key', () => {
      store.noteHistoryRequest(3);
      expect(history().pendingSince).toBe(clock);
      apply({
        type: 'sessionHistory',
        id: 3,
        entries: page(['c', 'd'], 30),
        before: 'cur-1',
        hasMore: true,
      });
      expect(history()).toMatchObject({ cursor: 'cur-1', hasMore: true, loaded: true });
      expect(history().pendingSince).toBeUndefined();

      store.noteHistoryRequest(3);
      apply({
        type: 'sessionHistory',
        id: 3,
        entries: page(['a', 'b', 'c'], 10),
        before: 'cur-2',
        hasMore: false,
      });
      expect(history().entries.map((e) => e.key)).toEqual(['a', 'b', 'c', 'd']);
      expect(history()).toMatchObject({ cursor: 'cur-2', hasMore: false });
    });

    it('never moves the cursor on a late duplicate reply', () => {
      store.noteHistoryRequest(3);
      apply({ type: 'sessionHistory', id: 3, entries: [], before: 'cur-1', hasMore: true });
      apply({ type: 'sessionHistory', id: 3, entries: [], before: 'cur-0', hasMore: true });
      expect(history().cursor).toBe('cur-1');
    });

    it('keeps what it has on an error, and has no more without a cursor', () => {
      store.noteHistoryRequest(3);
      apply({ type: 'sessionHistory', id: 3, entries: page(['x'], 1), hasMore: true });
      expect(history().hasMore).toBe(false);
      store.noteHistoryRequest(3);
      apply({
        type: 'sessionHistory',
        id: 3,
        entries: [],
        hasMore: false,
        error: 'Conductor is rate limiting this app.',
      });
      expect(history().entries.map((e) => e.key)).toEqual(['x']);
      expect(history().error).toBe('Conductor is rate limiting this app.');
      expect(history().pendingSince).toBeUndefined();
      store.noteHistoryRequest(3);
      expect(history().error).toBeUndefined();
    });

    it('is dropped with its agent', () => {
      apply({ type: 'agentCreated', id: 3 });
      store.noteHistoryRequest(3);
      apply({ type: 'agentClosed', id: 3 });
      expect(history()).toBeUndefined();
    });
  });

  describe('subscription', () => {
    it('notifies on change, keeps untouched slices identical, ignores unrelated messages', () => {
      let calls = 0;
      const unsubscribe = store.subscribe(() => calls++);
      const speciesBefore = store.getState().species;
      apply({ type: 'agentStatus', id: 1, status: 'active' });
      expect(calls).toBe(1);
      expect(store.getState().species).toBe(speciesBefore);
      const stateBefore = store.getState();
      apply({ type: 'layoutLoaded', layout: null });
      expect(store.getState()).toBe(stateBefore);
      expect(calls).toBe(1);
      unsubscribe();
      apply({ type: 'agentStatus', id: 1, status: 'waiting' });
      expect(calls).toBe(1);
    });
  });
});
