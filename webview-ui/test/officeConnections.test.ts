/**
 * Links, message projectiles and notices between agents (OfficeState's half;
 * the canvas passes only draw what these return). Synthetic agents, no DOM.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { afterEach, beforeEach, test } from 'vitest';

import type { AgentLink } from '../../core/src/messages.js';
import {
  AGENT_NOTICE_MAX_CHARS,
  AGENT_NOTICE_SEC,
  MESSAGE_PREVIEW_MAX_CHARS,
  MESSAGE_PREVIEW_SEC,
  PROJECTILE_MAX_IN_FLIGHT,
  PROJECTILE_MAX_SEC,
  PROJECTILE_MIN_SEC,
} from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { setPokemonThemeEnabled } from '../src/office/engine/pokemonTheme.js';
import { setPokemonSpecies } from '../src/office/sprites/pokemonSprites.js';
import { CharacterState, TILE_SIZE } from '../src/office/types.js';
import {
  floorLayout,
  flushDecodes,
  installFakeLoader,
  resetPokemonStore,
  speciesMessage,
} from './pokemonFixtures.js';

beforeEach(() => {
  resetPokemonStore();
  setPokemonThemeEnabled(true);
});

afterEach(() => {
  resetPokemonStore();
});

/** An office with spawned, idle agents at the given tiles (keyed by id). */
function office(at: Record<number, [number, number]>, cols = 40): OfficeState {
  const os = new OfficeState(floorLayout(cols, 10));
  for (const [key, [col, row]] of Object.entries(at)) {
    const id = Number(key);
    os.addAgent(id, 0, 0, undefined, true);
    const ch = os.characters.get(id)!;
    Object.assign(ch, {
      tileCol: col,
      tileRow: row,
      x: col * TILE_SIZE + TILE_SIZE / 2,
      y: row * TILE_SIZE + TILE_SIZE / 2,
      state: CharacterState.IDLE,
      isActive: false,
      // Never wander off mid-test.
      wanderTimer: 1_000,
    });
  }
  return os;
}

const link = (fromId: number, toId: number, kind: AgentLink['kind']): AgentLink => ({
  fromId,
  toId,
  kind,
  count: 1,
  lastAt: 0,
});

// ── links ───────────────────────────────────────────────────────

test('links draw only when both ends are in the office', () => {
  const os = office({ 1: [1, 1], 2: [5, 1] });
  os.setLinks([link(1, 2, 'spawned'), link(1, 9, 'messaged'), link(3, 3, 'watched')]);
  const segments = os.getLinkSegments();
  assert.equal(segments.length, 1);
  assert.equal(segments[0].from.id, 1);
  assert.equal(segments[0].to.id, 2);
  assert.equal(segments[0].kind, 'spawned');
  assert.equal(os.links.length, 2, 'a self-link is dropped on arrival');
});

test('one line per pair: spawned beats messaged beats watched, keeping its direction', () => {
  const os = office({ 1: [1, 1], 2: [5, 1], 3: [9, 1] });
  os.setLinks([
    link(2, 1, 'messaged'),
    link(1, 2, 'spawned'),
    link(3, 2, 'watched'),
    link(2, 3, 'messaged'),
  ]);
  const byPair = new Map(
    os.getLinkSegments().map((s) => [`${s.from.id}->${s.to.id}`, s.kind] as const),
  );
  assert.deepEqual(
    Object.fromEntries(byPair),
    { '1->2': 'spawned', '2->3': 'messaged' },
    'reverse duplicates collapse into the stronger link',
  );
});

test('a despawning end hides its links; a new snapshot replaces the old', () => {
  const os = office({ 1: [1, 1], 2: [5, 1] });
  os.setLinks([link(1, 2, 'spawned')]);
  os.removeAgent(2);
  assert.equal(os.getLinkSegments().length, 0);
  os.setLinks([]);
  assert.equal(os.links.length, 0);
});

// ── projectiles ─────────────────────────────────────────────────

test('a message capsule flies sender → receiver and leaves a preview on landing', () => {
  const os = office({ 1: [1, 1], 2: [6, 1] });
  assert.equal(os.launchProjectile(1, 2, 'messaged', '  please   review\nthe PR  '), true);
  const [capsule] = os.projectiles;
  assert.equal(capsule.preview, 'please review the PR', 'whitespace collapsed');
  assert.ok(capsule.dur >= PROJECTILE_MIN_SEC && capsule.dur <= PROJECTILE_MAX_SEC);

  os.update(capsule.dur / 2);
  assert.equal(os.projectiles.length, 1, 'still in the air');
  assert.equal(os.messagePreviews.length, 0, 'no preview before it lands');
  os.update(capsule.dur / 2 + 0.01);
  assert.equal(os.projectiles.length, 0);
  assert.equal(os.messagePreviews.length, 1);
  assert.equal(os.messagePreviews[0].toId, 2);
  assert.equal(os.messagePreviews[0].text, 'please review the PR');

  os.update(MESSAGE_PREVIEW_SEC - 0.1);
  assert.equal(os.messagePreviews.length, 1);
  os.update(0.2);
  assert.equal(os.messagePreviews.length, 0, 'gone after its few seconds');
});

test('flight time scales with distance, clamped', () => {
  const os = office({ 1: [0, 1], 2: [1, 1], 3: [39, 1] });
  os.launchProjectile(1, 2, 'messaged');
  os.launchProjectile(1, 3, 'messaged');
  assert.equal(os.projectiles[0].dur, PROJECTILE_MIN_SEC, 'neighbours: the minimum');
  assert.equal(os.projectiles[1].dur, PROJECTILE_MAX_SEC, 'across the office: the maximum');
});

test('at most PROJECTILE_MAX_IN_FLIGHT capsules; missing or identical ends are refused', () => {
  const os = office({ 1: [1, 1], 2: [6, 1] });
  for (let i = 0; i < PROJECTILE_MAX_IN_FLIGHT; i++) {
    assert.equal(os.launchProjectile(1, 2, 'messaged'), true);
  }
  assert.equal(os.launchProjectile(1, 2, 'messaged'), false, 'the cap holds');
  assert.equal(os.projectiles.length, PROJECTILE_MAX_IN_FLIGHT);
  assert.equal(os.launchProjectile(1, 1, 'messaged'), false);
  assert.equal(os.launchProjectile(1, 7, 'messaged'), false);
});

test('a capsule whose end leaves the office is dropped, preview and all', () => {
  const os = office({ 1: [1, 1], 2: [6, 1] });
  os.launchProjectile(1, 2, 'spawned', 'hello');
  os.removeAgent(2);
  os.update(0.01);
  assert.equal(os.projectiles.length, 0);
  os.update(PROJECTILE_MAX_SEC);
  assert.equal(os.messagePreviews.length, 0);
});

test('one preview per receiver: the newest message wins', () => {
  const os = office({ 1: [1, 1], 2: [6, 1], 3: [3, 4] });
  os.launchProjectile(1, 2, 'messaged', 'first');
  os.launchProjectile(3, 2, 'messaged', 'second');
  os.update(PROJECTILE_MAX_SEC);
  assert.deepEqual(
    os.messagePreviews.map((m) => m.text),
    ['second'],
  );
  const long = 'x'.repeat(MESSAGE_PREVIEW_MAX_CHARS * 2);
  os.launchProjectile(1, 3, 'messaged', long);
  assert.equal(os.projectiles[0].preview?.length, MESSAGE_PREVIEW_MAX_CHARS, 'capped');
});

test('a Pokémon sender attacks toward its receiver as the capsule leaves', async () => {
  const msg = speciesMessage(25);
  installFakeLoader([msg]);
  setPokemonSpecies(msg);
  await flushDecodes();
  const os = office({ 1: [1, 1], 2: [6, 1] });
  os.setAgentIdentity(1, { species: 25 });
  os.launchProjectile(1, 2, 'messaged');
  const sender = os.characters.get(1)!;
  assert.equal(sender.pmdAnim, 'message');
  assert.equal(sender.faceOverride, 2, 'faces right, toward the receiver');
});

// ── notices ─────────────────────────────────────────────────────

test('a notice shows above its agent for AGENT_NOTICE_SEC, replacing the last', () => {
  const os = office({ 1: [1, 1] });
  os.showNotice(1, 'Retrying');
  os.showNotice(1, 'Which branch?', 'error');
  assert.deepEqual(os.notices.get(1), {
    text: 'Which branch?',
    tone: 'error',
    timer: AGENT_NOTICE_SEC,
  });
  os.update(AGENT_NOTICE_SEC - 0.1);
  assert.ok(os.notices.has(1));
  os.update(0.2);
  assert.equal(os.notices.has(1), false);
});

test('notices: capped, blank or for a missing agent ignored, dropped with the agent', () => {
  const os = office({ 1: [1, 1] });
  os.showNotice(9, 'nobody here');
  os.showNotice(1, '   ');
  assert.equal(os.notices.size, 0);
  os.showNotice(1, 'y'.repeat(AGENT_NOTICE_MAX_CHARS + 50));
  assert.equal(os.notices.get(1)!.text.length, AGENT_NOTICE_MAX_CHARS);
  os.removeAgent(1);
  os.update(0.01);
  assert.equal(os.notices.size, 0);
});
