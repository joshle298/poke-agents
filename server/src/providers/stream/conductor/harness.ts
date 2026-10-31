/**
 * Which agent harness runs a Conductor session (CN §4). Detected from the
 * payload shape first: `config.harness` is missing on most messages sent by
 * other sessions or the API.
 */

import { CLAUDE_MODEL_PREFIX, GPT_MODEL_PREFIX } from './constants.js';
import type { ConductorItem } from './types.js';

export type Harness = 'claude' | 'codex' | 'cursor' | 'acp';

const KNOWN_HARNESSES: ReadonlySet<string> = new Set(['claude', 'codex', 'cursor', 'acp']);

export function isHarness(value: unknown): value is Harness {
  return typeof value === 'string' && KNOWN_HARNESSES.has(value);
}

/** Model id → harness, for when the feed has not said yet. */
export function harnessFromModel(model: string | null | undefined): Harness | undefined {
  if (!model) return undefined;
  if (model.startsWith(CLAUDE_MODEL_PREFIX)) return 'claude';
  if (model.startsWith(GPT_MODEL_PREFIX)) return 'codex';
  return 'cursor';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * First matching rule wins: codex event envelope, explicit config.harness,
 * system/init fingerprints, the session's resolved model, then the shape of a
 * Claude-style assistant payload. Undefined when the item says nothing (a user
 * message without config and no model known yet).
 */
export function detectHarness(
  item: ConductorItem,
  resolvedModel?: string | null,
): Harness | undefined {
  const content = asRecord(item.content) ?? {};
  const raw = asRecord(content.rawPayload);
  if (item.type === 'agent' && raw) {
    const event = asRecord(raw.event);
    if (event && typeof event.type === 'string') return 'codex';
  }
  const config = asRecord(content.config);
  if (item.type === 'userMessage' && isHarness(config?.harness)) return config.harness;
  if (item.type === 'agent' && raw) {
    if (raw.type === 'system' && raw.subtype === 'init') {
      if (raw.claude_code_version !== undefined) return 'claude';
      if (
        typeof raw.content === 'string' &&
        typeof raw.uuid === 'string' &&
        raw.uuid.startsWith('run-')
      ) {
        return 'cursor';
      }
    }
  }
  const fromModel = harnessFromModel(resolvedModel);
  if (fromModel) return fromModel;
  if (item.type === 'agent' && raw && raw.type === 'assistant') {
    const message = asRecord(raw.message);
    const id = message?.id;
    if ((typeof id === 'string' && id.startsWith('msg_')) || typeof message?.model === 'string') {
      return 'claude';
    }
    return 'cursor';
  }
  return undefined;
}
