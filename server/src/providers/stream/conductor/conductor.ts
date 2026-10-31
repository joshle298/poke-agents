/**
 * Conductor stream provider: polls the Conductor public API and pushes each
 * cloud session into the office as an agent.
 *
 * Contract used by server/src/cli.ts (the real implementation replaces this
 * placeholder body; keep the export names and option shape):
 */

import type { AgentEventSink, StreamProvider } from '../../../../../core/src/provider.js';

export interface ConductorProviderOptions {
  /** Directory for conductor-state.json. Defaults to ~/.pixel-agents. */
  stateDir?: string;
  /** Client-side request budget per minute (default 120). */
  budgetPerMinute?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Injected for tests: environment used for token and base URL resolution. */
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

export function createConductorProvider(_opts: ConductorProviderOptions = {}): StreamProvider {
  return {
    kind: 'stream',
    id: 'conductor',
    displayName: 'Conductor',
    protocolVersion: 1,
    formatToolStatus: (toolName: string) => `Using ${toolName}`,
    permissionExemptTools: new Set<string>(),
    subagentToolNames: new Set<string>(['Task', 'Agent']),
    readingTools: new Set<string>(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']),
    async start(sink: AgentEventSink): Promise<void> {
      sink.setStatus({
        state: 'disabled',
        message: 'Conductor provider not built yet',
        scope: { creator: 'me', activeWithinHours: 6, showIdle: true, maxSessions: 24 },
      });
    },
    async stop(): Promise<void> {},
  };
}
