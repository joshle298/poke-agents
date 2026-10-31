/**
 * The folder player's queue: which track plays now and which comes next, in
 * album order or shuffled. Pure (the random source is injected) so the rules
 * are unit-tested without audio.
 *
 * The queue loops forever, like a game's jukebox. `order` always holds at
 * least one track after `index`, so the player can preload what comes next:
 * when the current cycle runs out, the next one is appended (reshuffled in
 * shuffle mode, never starting with the track that just played), and history
 * older than one cycle is dropped.
 */

export type Rng = () => number;

export interface PlayQueue {
  /** The station's tracks in album order. */
  readonly base: readonly string[];
  /** Play order, history included. */
  readonly order: readonly string[];
  readonly index: number;
  readonly shuffle: boolean;
}

/** Fisher–Yates shuffle into a new array. */
export function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** One loop through the station, avoiding `avoidFirst` as its first track. */
function nextCycle(queue: Pick<PlayQueue, 'base' | 'shuffle'>, avoidFirst: string, rng: Rng) {
  if (!queue.shuffle) return [...queue.base];
  const cycle = shuffled(queue.base, rng);
  if (cycle.length > 1 && cycle[0] === avoidFirst) {
    const swap = 1 + Math.floor(rng() * (cycle.length - 1));
    [cycle[0], cycle[swap]] = [cycle[swap], cycle[0]];
  }
  return cycle;
}

/** Make sure a next track exists, and trim history to one cycle. */
function ensureAhead(queue: PlayQueue, rng: Rng): PlayQueue {
  let { order, index } = queue;
  if (index >= order.length - 1) {
    order = [...order, ...nextCycle(queue, order[index], rng)];
  }
  const keepFrom = Math.max(0, index - queue.base.length);
  if (keepFrom > 0) {
    order = order.slice(keepFrom);
    index -= keepFrom;
  }
  return order === queue.order && index === queue.index ? queue : { ...queue, order, index };
}

/**
 * A queue over `base` (track ids in album order), starting at `startId` when
 * given, or null for an empty station. Shuffled, the start track plays first
 * and the rest follow in random order.
 */
export function createQueue(
  base: readonly string[],
  options: { shuffle: boolean; startId?: string; rng: Rng },
): PlayQueue | null {
  if (base.length === 0) return null;
  const { shuffle, startId, rng } = options;
  const start = startId !== undefined && base.includes(startId) ? startId : undefined;
  let order: string[];
  let index = 0;
  if (shuffle) {
    const rest = shuffled(
      base.filter((id) => id !== start),
      rng,
    );
    order = start !== undefined ? [start, ...rest] : rest;
  } else {
    order = [...base];
    index = start !== undefined ? base.indexOf(start) : 0;
  }
  return ensureAhead({ base: [...base], order, index, shuffle }, rng);
}

export function currentTrack(queue: PlayQueue): string {
  return queue.order[queue.index];
}

/** The track that plays after this one (what to preload). */
export function upcomingTrack(queue: PlayQueue): string | undefined {
  return queue.order[queue.index + 1];
}

/** Move to the next track (looping). */
export function advance(queue: PlayQueue, rng: Rng): PlayQueue {
  const ahead = ensureAhead(queue, rng);
  return ensureAhead({ ...ahead, index: ahead.index + 1 }, rng);
}

/** Move to the previous track; at the start of the history, wrap to the end
 *  of the album (album order) or stay put (shuffle). */
export function retreat(queue: PlayQueue): PlayQueue {
  if (queue.index > 0) return { ...queue, index: queue.index - 1 };
  if (queue.shuffle) return queue;
  const last = queue.base[queue.base.length - 1];
  return { ...queue, order: [last, ...queue.order], index: 0 };
}

/** Turn shuffle on or off, keeping the current track playing. */
export function setQueueShuffle(queue: PlayQueue, shuffle: boolean, rng: Rng): PlayQueue {
  if (queue.shuffle === shuffle) return queue;
  const current = currentTrack(queue);
  const order = shuffle
    ? [
        current,
        ...shuffled(
          queue.base.filter((id) => id !== current),
          rng,
        ),
      ]
    : [...queue.base];
  const index = shuffle ? 0 : Math.max(0, queue.base.indexOf(current));
  return ensureAhead({ ...queue, order, index, shuffle }, rng);
}

/** Drop tracks that can't play (unsupported, missing). Null when none is left. */
export function withoutTracks(
  queue: PlayQueue,
  drop: ReadonlySet<string>,
  rng: Rng,
): PlayQueue | null {
  const base = queue.base.filter((id) => !drop.has(id));
  if (base.length === 0) return null;
  const before = queue.order.slice(0, queue.index).filter((id) => !drop.has(id));
  const after = queue.order.slice(queue.index).filter((id) => !drop.has(id));
  // The current track survives at `before.length`, or the next playable one
  // takes its place; when nothing playable was left ahead, a new cycle starts.
  let order = [...before, ...after];
  if (after.length === 0) {
    order = [
      ...order,
      ...nextCycle({ base, shuffle: queue.shuffle }, before[before.length - 1] ?? '', rng),
    ];
  }
  return ensureAhead({ ...queue, base, order, index: before.length }, rng);
}
