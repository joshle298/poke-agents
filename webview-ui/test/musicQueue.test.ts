import { describe, expect, it } from 'vitest';

import {
  advance,
  createQueue,
  currentTrack,
  type PlayQueue,
  retreat,
  type Rng,
  setQueueShuffle,
  shuffled,
  upcomingTrack,
  withoutTracks,
} from '../src/music/queue.js';

/** Deterministic random source (mulberry32). */
function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALBUM = ['t1', 't2', 't3', 't4', 't5'];

/** The next `n` tracks the queue plays, starting with the current one. */
function play(queue: PlayQueue, n: number, rng: Rng): string[] {
  const out: string[] = [];
  let q = queue;
  for (let i = 0; i < n; i++) {
    out.push(currentTrack(q));
    q = advance(q, rng);
  }
  return out;
}

describe('shuffled', () => {
  it('returns a permutation and leaves the input alone', () => {
    const input = [...ALBUM];
    const out = shuffled(input, seeded(1));
    expect([...out].sort()).toEqual([...ALBUM].sort());
    expect(input).toEqual(ALBUM);
  });
});

describe('album order', () => {
  it('plays from the chosen track and loops', () => {
    const rng = seeded(2);
    const queue = createQueue(ALBUM, { shuffle: false, startId: 't4', rng })!;
    expect(play(queue, 8, rng)).toEqual(['t4', 't5', 't1', 't2', 't3', 't4', 't5', 't1']);
  });

  it('always knows what comes next, and keeps history bounded', () => {
    const rng = seeded(3);
    let queue = createQueue(ALBUM, { shuffle: false, rng })!;
    for (let i = 0; i < 100; i++) {
      expect(upcomingTrack(queue)).toBeDefined();
      queue = advance(queue, rng);
      expect(queue.order.length).toBeLessThanOrEqual(ALBUM.length * 3);
    }
  });

  it('goes back through history, and from the first track to the last', () => {
    const rng = seeded(4);
    let queue = createQueue(ALBUM, { shuffle: false, rng })!;
    queue = advance(advance(queue, rng), rng);
    expect(currentTrack(queue)).toBe('t3');
    queue = retreat(queue);
    expect(currentTrack(queue)).toBe('t2');
    queue = retreat(retreat(queue));
    expect(currentTrack(queue)).toBe('t5');
    expect(currentTrack(advance(queue, rng))).toBe('t1');
  });

  it('ignores an unknown start track and refuses an empty station', () => {
    expect(
      currentTrack(createQueue(ALBUM, { shuffle: false, startId: 'zz', rng: seeded(5) })!),
    ).toBe('t1');
    expect(createQueue([], { shuffle: true, rng: seeded(5) })).toBeNull();
  });
});

describe('shuffle', () => {
  it('starts with the chosen track and plays every track once per loop', () => {
    for (let seed = 0; seed < 50; seed++) {
      const rng = seeded(seed);
      const queue = createQueue(ALBUM, { shuffle: true, startId: 't3', rng })!;
      const played = play(queue, ALBUM.length * 4, rng);
      expect(played[0]).toBe('t3');
      for (let loop = 0; loop < 4; loop++) {
        const cycle = played.slice(loop * ALBUM.length, (loop + 1) * ALBUM.length);
        expect([...cycle].sort()).toEqual([...ALBUM].sort());
      }
    }
  });

  it('never plays the same track twice in a row across a reshuffle', () => {
    for (let seed = 0; seed < 200; seed++) {
      const rng = seeded(seed);
      const played = play(createQueue(['a', 'b', 'c'], { shuffle: true, rng })!, 30, rng);
      for (let i = 1; i < played.length; i++) expect(played[i]).not.toBe(played[i - 1]);
    }
  });

  it('loops a one-track station', () => {
    const rng = seeded(6);
    expect(play(createQueue(['solo'], { shuffle: true, rng })!, 3, rng)).toEqual([
      'solo',
      'solo',
      'solo',
    ]);
  });

  it('stays on the first track when going back at the start', () => {
    const queue = createQueue(ALBUM, { shuffle: true, rng: seeded(7) })!;
    expect(retreat(queue)).toBe(queue);
  });

  it('toggles without interrupting the current track', () => {
    const rng = seeded(8);
    let queue = createQueue(ALBUM, { shuffle: false, startId: 't2', rng })!;
    queue = setQueueShuffle(queue, true, rng);
    expect(queue.shuffle).toBe(true);
    expect(currentTrack(queue)).toBe('t2');
    const shuffledRun = play(queue, ALBUM.length, rng);
    expect([...shuffledRun].sort()).toEqual([...ALBUM].sort());

    queue = advance(queue, rng);
    const now = currentTrack(queue);
    queue = setQueueShuffle(queue, false, rng);
    expect(currentTrack(queue)).toBe(now);
    const next = ALBUM[(ALBUM.indexOf(now) + 1) % ALBUM.length];
    expect(upcomingTrack(queue)).toBe(next);
    expect(setQueueShuffle(queue, false, rng)).toBe(queue);
  });
});

describe('withoutTracks', () => {
  it('skips a track that failed and keeps the rest in order', () => {
    const rng = seeded(9);
    const queue = createQueue(ALBUM, { shuffle: false, startId: 't2', rng })!;
    const next = withoutTracks(queue, new Set(['t2']), rng)!;
    expect(currentTrack(next)).toBe('t3');
    expect(play(next, 5, rng)).toEqual(['t3', 't4', 't5', 't1', 't3']);
  });

  it('starts a new loop when nothing playable was left ahead', () => {
    const rng = seeded(10);
    let queue = createQueue(['a', 'b', 'c'], { shuffle: false, rng })!;
    queue = advance(advance(queue, rng), rng);
    expect(currentTrack(queue)).toBe('c');
    const next = withoutTracks(queue, new Set(['c']), rng)!;
    expect(currentTrack(next)).toBe('a');
  });

  it('is null when nothing can play', () => {
    const queue = createQueue(['a', 'b'], { shuffle: true, rng: seeded(11) })!;
    expect(withoutTracks(queue, new Set(['a', 'b']), seeded(11))).toBeNull();
  });
});
