/**
 * Where a teammate goes (DESIGN §D "Teammate placement", critique F18). Claude
 * teammates keep upstream behaviour; a stream teammate keeps its own palette
 * and directory and clusters by its Lead only while the Lead's crowd is small.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { TEAMMATE_CLUSTER_MAX_CHILDREN } from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { placeTeammate } from '../src/office/engine/teammatePlacement.js';
import { Direction } from '../src/office/types.js';
import { floorLayout } from './pokemonFixtures.js';

const lead = { palette: 3, hueShift: 90, directoryName: 'lead-repo' };
const msg = { palette: 1, hueShift: 0, directoryName: 'child-repo' };

test('a Claude teammate inherits the Lead and always sits beside it (upstream)', () => {
  assert.deepEqual(placeTeammate({ isStream: false, msg, leadId: 7, lead, visibleChildren: 40 }), {
    palette: 3,
    hueShift: 90,
    directoryName: 'lead-repo',
    nearAgentId: 7,
  });
});

test('a stream teammate keeps the palette and directory the server sent', () => {
  const placed = placeTeammate({ isStream: true, msg, leadId: 7, lead, visibleChildren: 0 });
  assert.equal(placed.palette, 1);
  assert.equal(placed.hueShift, 0);
  assert.equal(placed.directoryName, 'child-repo');
  assert.equal(placed.nearAgentId, 7);
});

test('a stream teammate falls back to the Lead for what the server left out', () => {
  const placed = placeTeammate({ isStream: true, msg: {}, leadId: 7, lead, visibleChildren: 0 });
  assert.equal(placed.palette, 3);
  assert.equal(placed.hueShift, 90);
  assert.equal(placed.directoryName, 'lead-repo');
});

test('stream teammates cluster only while the Lead has at most 6 visible children', () => {
  const near = (visibleChildren: number) =>
    placeTeammate({ isStream: true, msg, leadId: 7, lead, visibleChildren }).nearAgentId;
  assert.equal(near(TEAMMATE_CLUSTER_MAX_CHILDREN - 1), 7, 'the sixth child still clusters');
  assert.equal(near(TEAMMATE_CLUSTER_MAX_CHILDREN), undefined, 'the seventh takes its own seat');
  assert.equal(
    placeTeammate({ isStream: true, msg, leadId: 7, visibleChildren: 0 }).nearAgentId,
    undefined,
    'no Lead in the office: the usual seat search',
  );
});

/** Two seats: a free one beside the Lead's tile (1,1) and a taken one far off. */
function addSeats(os: OfficeState): void {
  os.seats.set('by-lead', {
    uid: 'by-lead',
    seatCol: 2,
    seatRow: 1,
    facingDir: Direction.DOWN,
    assigned: false,
  });
  os.seats.set('far', {
    uid: 'far',
    seatCol: 18,
    seatRow: 8,
    facingDir: Direction.DOWN,
    assigned: true,
  });
}

/** Lead 1 at (1,1); `children` existing teammates; agent 50 seated far away. */
function linkLater(children: number, providerId?: string): OfficeState {
  const os = new OfficeState(floorLayout(20, 10));
  os.addAgent(1, 0, 0, undefined, true);
  Object.assign(os.characters.get(1)!, { tileCol: 1, tileRow: 1, seatId: null });
  for (let i = 0; i < children; i++) {
    os.addAgent(10 + i, 0, 0, undefined, true);
    os.characters.get(10 + i)!.leadAgentId = 1;
  }
  os.addAgent(50, 0, 0, undefined, true);
  const child = os.characters.get(50)!;
  // Seats arrive after everyone is placed, so none of them took a seat.
  addSeats(os);
  Object.assign(child, { seatId: 'far', tileCol: 18, tileRow: 8, providerId });
  os.setTeamInfo(50, undefined, 'child', false, 1, true);
  return os;
}

test('visibleChildCount counts a Lead’s teammates still in the office', () => {
  const os = linkLater(3, 'conductor');
  assert.equal(os.visibleChildCount(1), 4);
  os.removeAgent(10);
  assert.equal(os.visibleChildCount(1), 3, 'a despawning child no longer counts');
});

test('linking a stream child reseats it by its Lead only while the crowd is small', () => {
  assert.equal(linkLater(2, 'conductor').characters.get(50)!.seatId, 'by-lead');
  assert.equal(
    linkLater(TEAMMATE_CLUSTER_MAX_CHILDREN, 'conductor').characters.get(50)!.seatId,
    'far',
    'a seventh child keeps its own seat',
  );
  assert.equal(
    linkLater(TEAMMATE_CLUSTER_MAX_CHILDREN).characters.get(50)!.seatId,
    'by-lead',
    'Claude teammates always cluster (upstream)',
  );
});
