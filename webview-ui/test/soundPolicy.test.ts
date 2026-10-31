/**
 * The Pokémon sound policy: which happening plays which sounds, and when
 * nothing plays (silent resends, the quiet window after a connect, the
 * initial load, level fills, the theme off).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { ServerMessage } from '../../core/src/messages.js';
import {
  SOUND_ALERT_CRY_DELAY_MS,
  SOUND_ARRIVAL_CHAIN_MS,
  SOUND_EVOLUTION_CRY_DELAY_MS,
  SOUND_FAINT_CRY_SEMITONES,
  SOUND_FAINT_SFX_DELAY_MS,
  SOUND_LEVEL_SETTLE_MS,
  SOUND_POP_CRY_DELAY_MS,
  SOUND_QUIET_AFTER_CONNECT_MS,
  SOUND_THROW_POP_DELAY_MS,
} from '../src/audio/constants.js';
import type { SoundEvent } from '../src/audio/soundEvents.js';
import { cry, keepCues, sfx, sfxAfterCry } from '../src/audio/soundEvents.js';
import { SoundDirector } from '../src/audio/soundPolicy.js';

const PIKACHU = 25;
const RAICHU = 26;
const CHARMANDER = 4;
const CHARMELEON = 5;
const MEWTWO = 150;

let now: number;
let selected: number | null;
let director: SoundDirector;

const send = (msg: ServerMessage): SoundEvent[] =>
  director.handle(msg, { now, selectedAgentId: selected });
const names = (events: SoundEvent[]) => events.map((e) => e.name);

function created(
  id: number,
  extra: Partial<Extract<ServerMessage, { type: 'agentCreated' }>> = {},
): ServerMessage {
  return {
    type: 'agentCreated',
    id,
    providerId: 'conductor',
    species: PIKACHU,
    level: 5,
    ...extra,
  };
}

function status(
  id: number,
  value: 'active' | 'waiting' | 'error',
  extra: { awaitingInput?: boolean; silent?: boolean } = {},
): ServerMessage {
  return { type: 'agentStatus', id, status: value, ...extra };
}

function details(
  id: number,
  extra: Partial<Extract<ServerMessage, { type: 'agentDetails' }>>,
): ServerMessage {
  return { type: 'agentDetails', id, ...extra };
}

/** Connect, let the quiet window and the initial load pass, then add agents live. */
function liveOffice(...ids: number[]): void {
  director.connected(now);
  now += SOUND_QUIET_AFTER_CONNECT_MS + SOUND_ARRIVAL_CHAIN_MS + 1;
  for (const id of ids) send(created(id));
  // Past the level settle window, so level changes count.
  now += SOUND_LEVEL_SETTLE_MS + 1;
}

beforeEach(() => {
  now = 1_000_000;
  selected = null;
  director = new SoundDirector();
});

describe('needs you', () => {
  it('a question plays the alert, then the Pokémon cry', () => {
    liveOffice(1);
    send(status(1, 'active'));
    expect(send(status(1, 'waiting', { awaitingInput: true }))).toEqual([
      {
        name: 'needsYou',
        agentId: 1,
        cues: [sfx('alert'), cry(PIKACHU, SOUND_ALERT_CRY_DELAY_MS)],
      },
    ]);
  });

  it('a permission prompt does too, once while it stays open', () => {
    liveOffice(1);
    send(status(1, 'active'));
    expect(names(send({ type: 'agentToolPermission', id: 1 }))).toEqual(['needsYou']);
    expect(send({ type: 'agentToolPermission', id: 1 })).toEqual([]);
    send({ type: 'agentToolPermissionClear', id: 1 });
    expect(names(send({ type: 'agentToolPermission', id: 1 }))).toEqual(['needsYou']);
  });

  it('asking again while already waiting on you is not news', () => {
    liveOffice(1);
    send(status(1, 'waiting', { awaitingInput: true }));
    expect(send(status(1, 'waiting', { awaitingInput: true }))).toEqual([]);
    expect(send({ type: 'agentToolPermission', id: 1 })).toEqual([]);
  });

  it('a silent resend never sounds', () => {
    liveOffice(1);
    expect(send(status(1, 'waiting', { awaitingInput: true, silent: true }))).toEqual([]);
    expect(send(status(1, 'error', { silent: true }))).toEqual([]);
  });

  it('upstream agents keep the chime: nothing sounds for them here', () => {
    liveOffice();
    expect(send(created(7, { providerId: undefined }))).toEqual([]);
    now += SOUND_LEVEL_SETTLE_MS + 1;
    send(details(7, { level: 5, messageCount: 100 }));
    expect(send(status(7, 'waiting', { awaitingInput: true }))).toEqual([]);
    expect(send({ type: 'agentToolPermission', id: 7 })).toEqual([]);
    expect(send(status(7, 'error'))).toEqual([]);
    expect(send(details(7, { level: 6 }))).toEqual([]);
    expect(send({ type: 'agentClosed', id: 7 })).toEqual([]);
  });
});

describe('faint and revive', () => {
  it('an error plays the cry pitched down, then the faint slide', () => {
    liveOffice(1);
    send(status(1, 'active'));
    expect(send(status(1, 'error'))).toEqual([
      {
        name: 'faint',
        agentId: 1,
        cues: [
          cry(PIKACHU, 0, SOUND_FAINT_CRY_SEMITONES),
          sfxAfterCry('faint', SOUND_FAINT_SFX_DELAY_MS),
        ],
      },
    ]);
    expect(send(status(1, 'error'))).toEqual([]);
  });

  it('without its cry (Cries off, no cry for the species) the faint slide plays at once', () => {
    liveOffice(1);
    send(status(1, 'active'));
    const [faint] = send(status(1, 'error'));
    expect(keepCues(faint.cues, (c) => c.kind === 'sfx')).toEqual([sfx('faint')]);
    // With the cry kept, the slide still waits for it.
    expect(keepCues(faint.cues, () => true)).toEqual(faint.cues);
  });

  it('activity after an error heals', () => {
    liveOffice(1);
    send(status(1, 'error'));
    expect(send(status(1, 'active'))).toEqual([
      { name: 'revived', agentId: 1, cues: [sfx('heal')] },
    ]);
    expect(send(status(1, 'active'))).toEqual([]);
  });
});

describe('done', () => {
  it('only for the selected or a pinned session', () => {
    liveOffice(1, 2, 3);
    for (const id of [1, 2, 3]) send(status(id, 'active'));
    selected = 1;
    send({
      type: 'conductorSessions',
      sessions: [
        {
          sessionId: 's2',
          label: 'two',
          workspaceId: 'w',
          workspaceName: 'w',
          status: 'working',
          hidden: false,
          pinned: true,
          agentId: 2,
        },
      ],
    });
    expect(send(status(1, 'waiting'))).toEqual([{ name: 'done', agentId: 1, cues: [sfx('done')] }]);
    expect(names(send(status(2, 'waiting')))).toEqual(['done']);
    expect(send(status(3, 'waiting'))).toEqual([]);
  });

  it('needs a change: a repeated waiting is not a finished turn', () => {
    liveOffice(1);
    selected = 1;
    send(status(1, 'active'));
    expect(names(send(status(1, 'waiting')))).toEqual(['done']);
    expect(send(status(1, 'waiting'))).toEqual([]);
  });
});

describe('quiet window after a connect', () => {
  it('stays silent for the replay, then sounds', () => {
    director.connected(now);
    send(created(1));
    send(status(1, 'active'));
    expect(send(status(1, 'waiting', { awaitingInput: true }))).toEqual([]);
    expect(send({ type: 'agentToolPermission', id: 2 })).toEqual([]);
    expect(send({ type: 'agentClosed', id: 1 })).toEqual([]);
    now += SOUND_QUIET_AFTER_CONNECT_MS + 1;
    send(created(3));
    send(status(3, 'active'));
    expect(names(send(status(3, 'error')))).toEqual(['faint']);
  });

  it('a reconnect replay (existingAgents) is quiet too', () => {
    liveOffice(1);
    send({
      type: 'existingAgents',
      agents: [1],
      agentMeta: { '1': { species: PIKACHU } },
      directoryNames: {},
      externalAgents: {},
    });
    expect(send(status(1, 'error'))).toEqual([]);
    expect(send({ type: 'agentMessage', fromId: 1, toId: 2, kind: 'messaged', at: now })).toEqual(
      [],
    );
  });

  it('a replay forgets agents that left while the socket was down', () => {
    liveOffice(1, 2);
    send({
      type: 'existingAgents',
      agents: [2],
      agentMeta: {},
      directoryNames: {},
      externalAgents: {},
    });
    expect(director.isPresent(1)).toBe(false);
    expect(director.isPresent(2)).toBe(true);
    expect(director.speciesOf(2)).toBe(PIKACHU);
  });
});

describe('new sessions', () => {
  it('a live arrival pops its capsule, then cries', () => {
    liveOffice();
    expect(send(created(1, { species: CHARMANDER }))).toEqual([
      {
        name: 'arrived',
        agentId: 1,
        cues: [sfx('ballPop'), cry(CHARMANDER, SOUND_POP_CRY_DELAY_MS)],
      },
    ]);
  });

  it('a session its Lead created is thrown out first', () => {
    liveOffice();
    send(created(1, { species: MEWTWO }));
    now += 10_000;
    expect(send(created(2, { parentAgentId: 1, isTeammate: true }))).toEqual([
      {
        name: 'spawned',
        agentId: 2,
        cues: [
          sfx('ballThrow'),
          sfx('ballPop', SOUND_THROW_POP_DELAY_MS),
          cry(PIKACHU, SOUND_THROW_POP_DELAY_MS + SOUND_POP_CRY_DELAY_MS),
        ],
      },
    ]);
  });

  it('without a species there is no cry to play', () => {
    liveOffice();
    expect(send(created(1, { species: undefined }))).toEqual([
      { name: 'arrived', agentId: 1, cues: [sfx('ballPop')] },
    ]);
  });

  it('the initial load stays silent until the arrivals pause', () => {
    director.connected(now);
    send({
      type: 'existingAgents',
      agents: [],
      agentMeta: {},
      directoryNames: {},
      externalAgents: {},
    });
    expect(send(created(1))).toEqual([]);
    // The server keeps adopting sessions after the quiet window: still the initial load.
    now += SOUND_QUIET_AFTER_CONNECT_MS + 1_000;
    expect(send(created(2))).toEqual([]);
    now += 1_500;
    expect(send(created(3))).toEqual([]);
    now += 2_500;
    expect(names(send(created(4)))).toEqual(['arrived']);
  });

  it('a spawned message right after the arrival adds nothing; a later one throws', () => {
    liveOffice(1);
    send(created(2));
    expect(send({ type: 'agentMessage', fromId: 1, toId: 2, kind: 'spawned', at: now })).toEqual(
      [],
    );
    now += 10_000;
    expect(send({ type: 'agentMessage', fromId: 1, toId: 2, kind: 'spawned', at: now })).toEqual([
      { name: 'spawned', agentId: 2, cues: [sfx('ballThrow')] },
    ]);
  });
});

describe('levels and evolution', () => {
  it('a small live level step plays the level-up', () => {
    liveOffice(1);
    send(details(1, { level: 5, messageCount: 100 }));
    expect(send(details(1, { level: 6, messageCount: 144 }))).toEqual([
      { name: 'levelUp', agentId: 1, cues: [sfx('levelUp')] },
    ]);
    expect(send(details(1, { level: 6, messageCount: 150 }))).toEqual([]);
  });

  it('the first real level (first message count) is a fill, not a level-up', () => {
    liveOffice(1);
    send(details(1, { level: 1 }));
    expect(send(details(1, { level: 3, messageCount: 20 }))).toEqual([]);
    expect(names(send(details(1, { level: 4, messageCount: 36 })))).toEqual(['levelUp']);
  });

  it('a big jump is a fill, not a level-up', () => {
    liveOffice(1);
    send(details(1, { level: 2, messageCount: 4 }));
    expect(send(details(1, { level: 12, messageCount: 500 }))).toEqual([]);
  });

  it('levels filled in right after an arrival or a connect stay silent', () => {
    liveOffice();
    send(created(1, { level: 1 }));
    send(details(1, { level: 1, messageCount: 1 }));
    now += 2_000;
    expect(send(details(1, { level: 2, messageCount: 4 }))).toEqual([]);
    now += SOUND_LEVEL_SETTLE_MS;
    expect(names(send(details(1, { level: 3, messageCount: 16 })))).toEqual(['levelUp']);
  });

  it('crossing an evolution level plays the evolution, then the new cry', () => {
    liveOffice();
    send(created(1, { species: CHARMANDER, level: 15 }));
    now += SOUND_LEVEL_SETTLE_MS + 1;
    send(details(1, { level: 15, messageCount: 784 }));
    expect(send(details(1, { level: 16, species: CHARMELEON, messageCount: 900 }))).toEqual([
      {
        name: 'evolution',
        agentId: 1,
        cues: [sfx('evolution'), cry(CHARMELEON, SOUND_EVOLUTION_CRY_DELAY_MS)],
      },
    ]);
  });

  it('a species change without an evolution level (a Lead promoted) is quiet', () => {
    liveOffice(1);
    send(details(1, { level: 5, messageCount: 100 }));
    expect(send(details(1, { species: MEWTWO }))).toEqual([]);
    expect(send(details(1, { species: RAICHU, level: 5 }))).toEqual([]);
  });
});

describe('messages and recall', () => {
  it('a message between sessions whooshes; a watched link does not', () => {
    liveOffice(1, 2);
    expect(send({ type: 'agentMessage', fromId: 1, toId: 2, kind: 'messaged', at: now })).toEqual([
      { name: 'message', agentId: 2, cues: [sfx('message')] },
    ]);
    expect(send({ type: 'agentMessage', fromId: 1, toId: 2, kind: 'watched', at: now })).toEqual(
      [],
    );
  });

  it('leaving the office recalls, once', () => {
    liveOffice(1);
    expect(send({ type: 'agentClosed', id: 1 })).toEqual([
      { name: 'recall', agentId: 1, cues: [sfx('recall')] },
    ]);
    expect(send({ type: 'agentClosed', id: 1 })).toEqual([]);
  });
});

describe('theme off', () => {
  it('keeps only the alert sounds', () => {
    liveOffice(1);
    send({ type: 'pokemonThemeUpdated', enabled: false });
    send(status(1, 'active'));
    expect(send(status(1, 'waiting', { awaitingInput: true }))).toEqual([
      { name: 'needsYou', agentId: 1, cues: [sfx('alert')] },
    ]);
    send(status(1, 'active'));
    expect(send(status(1, 'error'))).toEqual([{ name: 'faint', agentId: 1, cues: [sfx('faint')] }]);
    expect(send(created(2))).toEqual([]);
    expect(send({ type: 'agentClosed', id: 2 })).toEqual([]);
  });
});

describe('Pokédex', () => {
  it('opening plays its cry (a user sound), closing a blip', () => {
    liveOffice(1);
    expect(director.pokedexOpened(1)).toEqual([
      { name: 'pokedex', agentId: 1, cues: [cry(PIKACHU)], user: true },
    ]);
    expect(director.pokedexOpened(99)).toEqual([
      { name: 'pokedex', agentId: 99, cues: [sfx('blip')], user: true },
    ]);
    expect(director.pokedexClosed()).toEqual([{ name: 'uiBlip', cues: [sfx('blip')], user: true }]);
    expect(director.isPresent(1)).toBe(true);
    send({ type: 'agentClosed', id: 1 });
    expect(director.isPresent(1)).toBe(false);
  });
});
