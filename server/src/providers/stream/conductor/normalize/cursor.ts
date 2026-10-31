/**
 * Cursor harness normalizer (CN §5.2). Payloads are Claude-shaped with quirks:
 *
 * - No `session_state_changed`: a turn starts with the user message (or
 *   `system/init`) and `result` is the only turn end (`finished` | `error`).
 * - No usage and no model on assistant records, so no context gauge.
 * - `{type:'error', content}` precedes `result{subtype:'error'}` and carries
 *   the message to show.
 * - Tool names are partly lowercase (`grep`, `updateTodos`, `readLints`,
 *   `delete`) and tool ids contain a newline (opaque strings, never split).
 *
 * The ACP harness has not been observed; its Claude-shaped payloads use this
 * dialect too.
 */

import type { ConductorItem } from '../types.js';
import { handleClaudeShaped } from './claude.js';
import {
  asString,
  clipError,
  handleUserMessage,
  itemTime,
  type NormState,
  noteItem,
  type ProviderEvent,
  rawPayload,
  startTurn,
} from './shared.js';

export function normalizeCursorItem(item: ConductorItem, state: NormState): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  noteItem(item, state);
  if (item.type === 'userMessage') {
    handleUserMessage(item, state, out);
    return out;
  }
  const raw = rawPayload(item);
  if (item.type !== 'agent' || !raw) return out;
  if (raw.type === 'system' && raw.subtype === 'init') {
    const model = asString(raw.content);
    if (model) state.model = model;
    startTurn(state, itemTime(item), out);
    return out;
  }
  if (raw.type === 'error') {
    state.lastError = clipError(asString(raw.content)) ?? state.lastError;
    return out;
  }
  handleClaudeShaped(item, raw, state, out);
  return out;
}
