/**
 * FileStateAdapter: shared StateAdapter implementation for both VS Code and standalone.
 *
 * Settings (per adapter namespace) persist to
 *   ~/.pixel-agents/config.json  under keys "vscode" or "standalone".
 *
 * Agents + seats (per adapter) persist to
 *   ~/.pixel-agents/<namespace>-state.json (the demo office: demo-state.json)
 *
 * Runtime visibility (which agents show in the office) is scope-controlled by the
 * runtime scanner + Watch All Sessions toggle, not by persistence. Both adapters
 * can observe the same ~/.claude/projects/ filesystem; each keeps its own local
 * agent IDs and seat mappings.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { PersistedAgent } from '../../core/src/schemas.js';
import type { AdapterSettingKey, AdapterSettings, ConfigNamespace } from './configPersistence.js';
import { ADAPTER_SETTING_KEYS, readConfig, writeConfig } from './configPersistence.js';
import { LAYOUT_FILE_DIR, STREAM_AGENT_MEMORY_MAX } from './constants.js';
import type { StreamAgentMemory, StreamAgentRecord } from './streamAgentDriver.js';

const ADAPTER_SETTING_KEY_SET: ReadonlySet<string> = new Set(ADAPTER_SETTING_KEYS);

/** Strip leading "pixel-agents." prefix to match AdapterSettings field names. */
function settingNameOf(key: string): AdapterSettingKey | null {
  const bare = key.startsWith('pixel-agents.') ? key.slice('pixel-agents.'.length) : key;
  return ADAPTER_SETTING_KEY_SET.has(bare) ? (bare as AdapterSettingKey) : null;
}

interface AdapterState {
  agents: PersistedAgent[];
  seats: Record<string, { palette?: number; hueShift?: number; seatId?: string }>;
  /** Stream sessions seen before (`conductor:<uuid>` -> agent id + Pokémon), so
   *  a session returns as the same agent in the same seat. Survives the agent
   *  list being rewritten to live agents only. */
  streamAgents: Record<string, StreamAgentRecord>;
}

export interface FileStateAdapterOptions {
  namespace: ConfigNamespace;
  /** Stem of the agents-and-seats file (`<stem>-state.json`); default: the
   *  namespace. The demo office keeps its own while sharing the settings. */
  stateFileStem?: string;
}

export class FileStateAdapter implements StateAdapter, StreamAgentMemory {
  private readonly namespace: ConfigNamespace;
  private readonly stateFilePath: string;

  constructor(options: FileStateAdapterOptions) {
    this.namespace = options.namespace;
    this.stateFilePath = path.join(
      os.homedir(),
      LAYOUT_FILE_DIR,
      options.stateFileStem
        ? `${options.stateFileStem}-state.json`
        : `${options.namespace}-state.json`,
    );
  }

  // ── Settings (shared config.json, per-namespace section) ────

  getSetting<T>(key: string, defaultValue: T): T {
    const field = settingNameOf(key);
    if (!field) return defaultValue;
    const config = readConfig();
    return config[this.namespace][field] as unknown as T;
  }

  setSetting<T>(key: string, value: T): void {
    const field = settingNameOf(key);
    if (!field) return;
    const config = readConfig();
    // Narrow by field to keep the union-safe write. Each entry is a boolean or string.
    (config[this.namespace] as unknown as Record<string, unknown>)[field] = value;
    writeConfig(config);
  }

  // ── Agents + seats (adapter-scoped file) ────────────────────

  loadAgents(): PersistedAgent[] {
    return this.readState().agents;
  }

  saveAgents(agents: PersistedAgent[]): void {
    const state = this.readState();
    state.agents = agents;
    this.writeState(state);
  }

  loadSeats(): Record<string, { palette?: number; hueShift?: number; seatId?: string }> {
    return this.readState().seats;
  }

  saveSeats(seats: Record<string, { palette?: number; hueShift?: number; seatId?: string }>): void {
    const state = this.readState();
    state.seats = seats;
    this.writeState(state);
  }

  // ── Stream sessions (StreamAgentMemory) ─────────────────────

  loadStreamAgents(): Map<string, StreamAgentRecord> {
    return new Map(Object.entries(this.readState().streamAgents));
  }

  saveStreamAgent(key: string, record: StreamAgentRecord): void {
    const state = this.readState();
    // Re-inserted last, so the oldest entries are the first keys: those go
    // when the map outgrows its cap.
    delete state.streamAgents[key];
    state.streamAgents[key] = record;
    const keys = Object.keys(state.streamAgents);
    for (const old of keys.slice(0, Math.max(0, keys.length - STREAM_AGENT_MEMORY_MAX))) {
      delete state.streamAgents[old];
    }
    this.writeState(state);
  }

  // ── Internal state-file I/O ─────────────────────────────────

  private readState(): AdapterState {
    try {
      if (!fs.existsSync(this.stateFilePath)) {
        return { agents: [], seats: {}, streamAgents: {} };
      }
      const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AdapterState>;
      return {
        agents: Array.isArray(parsed.agents) ? (parsed.agents as PersistedAgent[]) : [],
        seats:
          parsed.seats && typeof parsed.seats === 'object'
            ? (parsed.seats as AdapterState['seats'])
            : {},
        streamAgents: parseStreamAgents(parsed.streamAgents),
      };
    } catch (err) {
      console.error('[Pixel Agents] Failed to read adapter state:', err);
      return { agents: [], seats: {}, streamAgents: {} };
    }
  }

  private writeState(state: AdapterState): void {
    const dir = path.dirname(this.stateFilePath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const json = JSON.stringify(state, null, 2);
      const tmpPath = this.stateFilePath + '.tmp';
      fs.writeFileSync(tmpPath, json, 'utf-8');
      fs.renameSync(tmpPath, this.stateFilePath);
    } catch (err) {
      console.error('[Pixel Agents] Failed to write adapter state:', err);
    }
  }
}

/** Keep only well-formed entries: the file is hand-editable. */
function parseStreamAgents(raw: unknown): Record<string, StreamAgentRecord> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, StreamAgentRecord> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    if (!Number.isSafeInteger(v.agentId) || (v.agentId as number) < 1) continue;
    out[key] = {
      agentId: v.agentId as number,
      pokemonLine: typeof v.pokemonLine === 'string' ? v.pokemonLine : undefined,
      species: Number.isSafeInteger(v.species) ? (v.species as number) : undefined,
      shiny: typeof v.shiny === 'boolean' ? v.shiny : undefined,
    };
  }
  return out;
}

// Re-export for callers that want to construct AdapterSettings defaults directly.
/** @public */
export type { AdapterSettings, ConfigNamespace };
