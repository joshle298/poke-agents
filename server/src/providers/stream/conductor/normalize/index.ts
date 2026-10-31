/**
 * Picks the dialect normalizer for an item. The harness is detected once per
 * session (payload shape first, then the resolved model) and cached in state.
 */

import { detectHarness } from '../harness.js';
import type { ConductorItem } from '../types.js';
import { normalizeClaudeItem } from './claude.js';
import { normalizeCodexItem } from './codex.js';
import { normalizeCursorItem } from './cursor.js';
import { asRecord, type NormState, type ProviderEvent } from './shared.js';

export function normalizeItem(item: ConductorItem, state: NormState): ProviderEvent[] {
  if (!state.harness) {
    const detected = detectHarness(item, state.resolvedModel);
    if (detected) state.harness = detected;
  }
  // A codex envelope is unambiguous even when the cached harness disagrees.
  const raw = asRecord(item.content?.rawPayload);
  if (item.type === 'agent' && asRecord(raw?.event)) return normalizeCodexItem(item, state);
  switch (state.harness) {
    case 'codex':
      return normalizeCodexItem(item, state);
    case 'cursor':
    case 'acp':
      return normalizeCursorItem(item, state);
    default:
      return normalizeClaudeItem(item, state);
  }
}
