/**
 * Optional AgentEventSink extension: seed a session silently.
 *
 * A provider adopts a session with `upsertSession` and then emits whatever its
 * reconstructed state adds (open tools, an open question, a permission
 * request). Those events describe the past, not something that just
 * happened, so the office must not chime or play turn-end effects for them:
 * a session already waiting on the user would chime on every server start and
 * every re-adoption. A sink that implements this marks every status it
 * broadcasts during `run` as silent. StreamAgentDriver implements it.
 */

import type { AgentEventSink } from '../../../../core/src/provider.js';

export interface SilentSeedSink {
  seedSilently(sessionId: string, run: () => void): void;
}

export function canSeedSilently(sink: AgentEventSink): sink is AgentEventSink & SilentSeedSink {
  return typeof (sink as Partial<SilentSeedSink>).seedSilently === 'function';
}
