import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../core/src/provider.js';
import { detectHarness } from '../src/providers/stream/conductor/harness.js';
import { unwrapShellCommand } from '../src/providers/stream/conductor/normalize/codex.js';
import { normalizeItem } from '../src/providers/stream/conductor/normalize/index.js';
import {
  createNormState,
  type NormState,
  type ProviderEvent,
} from '../src/providers/stream/conductor/normalize/shared.js';
import {
  CONDUCTOR_READING_TOOLS,
  conductorToolName,
  formatConductorToolStatus,
} from '../src/providers/stream/conductor/tools.js';
import type { ConductorItem } from '../src/providers/stream/conductor/types.js';

const FIXTURES = path.join(__dirname, 'fixtures', 'conductor');

function fixture(name: string): ConductorItem[] {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf-8')) as ConductorItem[];
}

function replay(items: ConductorItem[], state: NormState): ProviderEvent[] {
  return items.flatMap((item) => normalizeItem(item, state));
}

function agentEvents(events: ProviderEvent[]): AgentEvent[] {
  return events.filter((e): e is AgentEvent => e.kind !== 'log');
}

/** Compact event trace: kinds, with tool names / outcomes where they matter. */
function trace(events: AgentEvent[], opts: { usage?: boolean } = {}): string[] {
  return events
    .filter((e) => opts.usage || e.kind !== 'contextUsage')
    .map((e) => {
      switch (e.kind) {
        case 'toolStart':
          return `toolStart:${e.toolName}`;
        case 'turnEnd':
          return `turnEnd:${e.outcome ?? 'done'}`;
        case 'subagentStart':
          return `subagentStart:${e.toolName}`;
        default:
          return e.kind;
      }
    });
}

describe('Claude harness', () => {
  it('normalizes a full turn: tools, main-chain usage with the stated window, turn end on idle', () => {
    const state = createNormState({ resolvedModel: 'claude-opus-5-5[1m]' });
    const events = replay(fixture('claude-turn.json'), state);
    const agent = agentEvents(events);
    expect(trace(agent)).toEqual([
      'turnStart',
      'toolStart:Bash',
      'toolEnd',
      'toolStart:Read',
      'toolEnd',
      'toolStart:Edit',
      'toolEnd',
      'turnEnd:done',
    ]);
    const usage = agent.filter((e) => e.kind === 'contextUsage');
    expect(usage.at(-1)).toEqual({
      kind: 'contextUsage',
      tokens: 2 + 200 + 30_700 + 25,
      model: 'claude-opus-5-5[1m]',
      window: 1_000_000,
    });
    expect(agent.at(-1)).toEqual({ kind: 'turnEnd', outcome: 'done' });
    expect(state.harness).toBe('claude');
    expect(state.turnOpen).toBe(false);
    expect(state.openTools.size).toBe(0);
    const logs = events.filter((e) => e.kind === 'log');
    expect(logs.map((l) => l.role)).toEqual(['user', 'assistant']);
  });

  it('opens and answers AskUserQuestion: Waiting for input, then active, then done', () => {
    const state = createNormState();
    const pending = agentEvents(replay(fixture('wait-ask-user-question-pending.json'), state));
    expect(trace(pending)).toEqual(['turnStart', 'toolStart:AskUserQuestion', 'awaitingInput']);
    expect(state.awaiting).toBe(true);
    expect(state.permissionPending).toBe(false);

    const answered = agentEvents(
      replay(fixture('wait-ask-user-question-answered-tail.json'), state),
    );
    expect(trace(answered)).toEqual(['toolEnd', 'turnStart', 'turnEnd:done']);
    expect(state.awaiting).toBe(false);
  });

  it('maps ExitPlanMode + requires_action to a permission request, and rejection to aborted', () => {
    const state = createNormState();
    const pending = agentEvents(replay(fixture('wait-plan-approval-pending.json'), state));
    expect(trace(pending)).toEqual(['turnStart', 'toolStart:ExitPlanMode', 'permissionRequest']);
    expect(formatConductorToolStatus('ExitPlanMode', {})).toBe('Plan ready for review');

    const rejected = agentEvents(replay(fixture('wait-plan-approval-rejected-tail.json'), state));
    expect(trace(rejected)).toEqual(['permissionClear', 'toolEnd', 'turnEnd:aborted']);
    expect(state.permissionPending).toBe(false);
  });

  it('turns a usage-limit result into an errored turn with the API message, without a gauge', () => {
    const state = createNormState();
    const agent = agentEvents(replay(fixture('error-claude-usage-limit.json'), state));
    expect(trace(agent, { usage: true })).toEqual(['turnStart', 'turnEnd:error']);
    expect(agent.at(-1)).toEqual({
      kind: 'turnEnd',
      outcome: 'error',
      errorMessage: "You've hit your session limit · resets 1:00pm (UTC)",
    });
    expect(state.lastOutcome?.outcome).toBe('error');
  });

  it('tracks a background Agent spawn and its sub-agent records without moving the gauge', () => {
    const sid = 'synthetic-session';
    let index = 0;
    const agentItem = (rawPayload: Record<string, unknown>): ConductorItem => ({
      id: `item-${++index}`,
      sessionId: sid,
      sessionIndex: index,
      type: 'agent',
      content: { rawPayload },
      receivedAt: `2026-01-01T12:00:${String(index).padStart(2, '0')}.000Z`,
    });
    const usage = { input_tokens: 1, cache_read_input_tokens: 1000, output_tokens: 10 };
    const items: ConductorItem[] = [
      agentItem({ type: 'system', subtype: 'session_state_changed', state: 'running' }),
      agentItem({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'msg_a',
          model: 'claude-opus-5-5',
          usage,
          content: [
            {
              type: 'tool_use',
              id: 'toolu_agent',
              name: 'Agent',
              input: { description: 'Profile lookups', run_in_background: true },
            },
          ],
        },
      }),
      agentItem({
        type: 'system',
        subtype: 'task_started',
        task_id: 'task1',
        tool_use_id: 'toolu_agent',
        task_type: 'local_agent',
        is_backgrounded: true,
      }),
      agentItem({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'launched' }],
        },
        tool_use_result: { isAsync: true, status: 'async_launched' },
      }),
      agentItem({
        type: 'assistant',
        parent_tool_use_id: 'toolu_agent',
        message: {
          id: 'msg_b',
          model: 'claude-opus-5-5',
          usage: { input_tokens: 1, cache_read_input_tokens: 400_000, output_tokens: 5 },
          content: [{ type: 'tool_use', id: 'toolu_sub', name: 'Bash', input: { command: 'ls' } }],
        },
      }),
      agentItem({
        type: 'user',
        parent_tool_use_id: 'toolu_agent',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_sub', content: 'ok' }] },
      }),
      agentItem({
        type: 'result',
        subtype: 'success',
        is_error: false,
        terminal_reason: 'completed',
      }),
      agentItem({ type: 'system', subtype: 'session_state_changed', state: 'idle' }),
      agentItem({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task1',
        tool_use_id: 'toolu_agent',
        status: 'completed',
      }),
    ];
    const state = createNormState({ resolvedModel: 'claude-opus-5-5[1m]' });
    const agent = agentEvents(replay(items.slice(0, 8), state));
    expect(trace(agent)).toEqual([
      'turnStart',
      'toolStart:Agent',
      'subagentStart:Bash',
      'subagentEnd',
      'turnEnd:done',
    ]);
    expect(agent.find((e) => e.kind === 'toolStart')).toMatchObject({ runInBackground: true });
    const gauges = agent.filter((e) => e.kind === 'contextUsage');
    expect(gauges).toEqual([{ kind: 'contextUsage', tokens: 1011, model: 'claude-opus-5-5[1m]' }]);
    // The background agent outlives the turn and ends on its task notification.
    expect(state.openTools.has('toolu_agent')).toBe(true);
    expect(trace(agentEvents(replay(items.slice(8), state)))).toEqual(['toolEnd']);
    expect(state.openTools.size).toBe(0);
  });
});

describe('sub-agents whose spawn predates the replayed tail', () => {
  it('opens the unseen Claude spawn as a background Agent and ends it on its notification', () => {
    let index = 0;
    const item = (rawPayload: Record<string, unknown>): ConductorItem => ({
      id: `late-${++index}`,
      sessionId: 'late',
      sessionIndex: 900 + index,
      type: 'agent',
      content: { rawPayload },
      receivedAt: '2026-01-01T12:00:00.000Z',
    });
    const items = [
      item({
        type: 'assistant',
        parent_tool_use_id: 'toolu_old_spawn',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_sub1', name: 'Read', input: { file_path: '/a/b.ts' } },
          ],
        },
      }),
      item({
        type: 'user',
        parent_tool_use_id: 'toolu_old_spawn',
        task_description: 'Profile lookups',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_sub1', content: 'ok' }] },
      }),
      item({
        type: 'system',
        subtype: 'task_notification',
        tool_use_id: 'toolu_old_spawn',
        status: 'completed',
      }),
      item({
        type: 'system',
        subtype: 'task_started',
        task_id: 'b1',
        tool_use_id: 'toolu_by_subagent',
        task_type: 'local_bash',
        description: 'Run the unit tests',
        owned_by_subagent: true,
      }),
    ];
    const state = createNormState({ harness: 'claude' });
    const events = replay(items, state);
    const agent = agentEvents(events);
    expect(trace(agent)).toEqual([
      'toolStart:Agent',
      'subagentStart:Read',
      'subagentEnd',
      'toolEnd',
    ]);
    // A task with no tool call in view still shows up in the Pokédex.
    expect(events.filter((e) => e.kind === 'log')).toEqual([
      expect.objectContaining({ role: 'tool', text: 'Running: Run the unit tests' }),
    ]);
    expect(agent[0]).toMatchObject({ toolId: 'toolu_old_spawn', runInBackground: true });
    // A background sub-agent does not make the session itself active.
    expect(state.turnOpen).toBe(false);
  });

  it('opens a Codex sub-agent reported working whose spawn was not replayed', () => {
    const state = createNormState({ harness: 'codex' });
    const agent = agentEvents(
      normalizeItem(
        {
          id: 'status-1',
          sessionId: 'codex-late',
          sessionIndex: 5_000,
          type: 'agent',
          content: {
            rawPayload: {
              event: { type: 'codex.subAgentStatus', parentToolUseId: 'call_old', working: true },
              thread_id: 'thread',
            },
          },
          receivedAt: '2026-01-01T12:00:00.000Z',
        },
        state,
      ),
    );
    expect(agent).toEqual([
      {
        kind: 'toolStart',
        toolId: 'call_old',
        toolName: 'Agent',
        input: { description: '' },
        runInBackground: true,
      },
    ]);
  });
});

describe('Cursor harness', () => {
  it('normalizes lowercase tools and ends the turn on result, without usage', () => {
    const state = createNormState();
    const items = fixture('cursor-turn.json');
    const agent = agentEvents(replay(items, state));
    expect(trace(agent, { usage: true })).toEqual([
      'turnStart',
      'toolStart:Grep',
      'toolEnd',
      'toolStart:Edit',
      'toolEnd',
      'toolStart:Bash',
      'toolEnd',
      'turnEnd:done',
    ]);
    expect(state.harness).toBe('cursor');
    // Tool ids contain a newline and must survive as opaque strings.
    const starts = agent.filter((e) => e.kind === 'toolStart');
    const ends = agent.filter((e) => e.kind === 'toolEnd');
    expect(starts[0].toolId).toContain('\n');
    expect(ends.map((e) => e.toolId)).toEqual(starts.map((e) => e.toolId));
  });

  it('shows the provider error text on an errored result', () => {
    const state = createNormState();
    const agent = agentEvents(replay(fixture('error-cursor-provider.json'), state));
    expect(trace(agent)).toEqual(['turnStart', 'turnEnd:error']);
    expect(agent.at(-1)).toMatchObject({
      outcome: 'error',
      errorMessage: expect.stringContaining('Provider Error'),
    });
  });
});

describe('Codex harness', () => {
  it('normalizes a turn: command actions, file change, MCP call, usage from turn.completed', () => {
    const state = createNormState({ resolvedModel: 'gpt-6.1-sol' });
    const events = replay(fixture('codex-turn.json'), state);
    const agent = agentEvents(events);
    expect(trace(agent, { usage: true })).toEqual([
      'turnStart',
      'toolStart:Bash',
      'toolEnd',
      'toolStart:Read',
      'toolEnd',
      'toolStart:Edit',
      'toolEnd',
      'toolStart:mcp__conductor__GetWorkspaceDiff',
      'toolEnd',
      'contextUsage',
      'turnEnd:done',
    ]);
    const starts = agent.filter((e) => e.kind === 'toolStart');
    expect(formatConductorToolStatus(starts[0].toolName, starts[0].input)).toBe(
      'Running: npm test',
    );
    expect(formatConductorToolStatus(starts[1].toolName, starts[1].input)).toBe(
      'Reading missing-file.txt',
    );
    expect(formatConductorToolStatus(starts[3].toolName, starts[3].input)).toBe(
      'Using conductor: GetWorkspaceDiff',
    );
    expect(agent.find((e) => e.kind === 'contextUsage')).toEqual({
      kind: 'contextUsage',
      tokens: 41_120,
      model: 'gpt-6.1-sol',
    });
    const assistant = events.filter((e) => e.kind === 'log' && e.role === 'assistant');
    expect(assistant).toHaveLength(2);
  });

  it('keeps a mid-turn message inside the running turn', () => {
    const state = createNormState();
    const agent = agentEvents(replay(fixture('child-first-message.json'), state));
    expect(trace(agent)).toEqual([
      'turnStart',
      'toolStart:Bash',
      'toolEnd',
      'toolStart:Bash',
      'toolEnd',
      'turnEnd:done',
    ]);
    expect(agent.filter((e) => e.kind === 'turnStart')).toHaveLength(1);
  });

  it('turns an async question into a notice while the session keeps working', () => {
    const state = createNormState();
    const agent = agentEvents(replay(fixture('wait-codex-async-question.json'), state));
    expect(trace(agent)).toEqual(['turnStart', 'notice', 'toolStart:Bash']);
    expect(agent[1]).toEqual({
      kind: 'notice',
      text: expect.stringContaining('Please sign in on your Mac'),
      tone: 'info',
    });
    expect(state.turnOpen).toBe(true);
    expect(state.awaiting).toBe(false);
  });

  it('reports retries as notices and the failure as an errored turn', () => {
    const state = createNormState();
    const agent = agentEvents(replay(fixture('error-codex-turn-failed.json'), state));
    expect(trace(agent)).toEqual([
      'turnStart',
      'notice',
      'notice',
      'notice',
      'notice',
      'notice',
      'turnEnd:error',
    ]);
    expect(agent.filter((e) => e.kind === 'notice').map((e) => e.text)).toEqual([
      'Reconnecting... 1/5',
      'Reconnecting... 2/5',
      'Reconnecting... 3/5',
      'Reconnecting... 4/5',
      'Reconnecting... 5/5',
    ]);
    expect(agent.at(-1)).toEqual({
      kind: 'turnEnd',
      outcome: 'error',
      errorMessage: 'rate limit exceeded: synthetic details',
    });
  });

  it('models native sub-agents: spawn as a background Agent, their items as sub-tools', () => {
    const thread = 'thread-parent';
    let index = 0;
    const codexItem = (event: Record<string, unknown>): ConductorItem => ({
      id: `codex-${++index}`,
      sessionId: 'synthetic-codex',
      sessionIndex: index,
      type: 'agent',
      content: { rawPayload: { event, thread_id: thread } },
      receivedAt: '2026-01-01T12:00:00.000Z',
    });
    const spawn = {
      type: 'subAgentActivity',
      id: 'call_spawn',
      kind: 'started',
      agentThreadId: 'thread-child',
      agentPath: '/root/pr_inventory',
      receiverThreads: [{ id: 'thread-child', agentNickname: 'Ohm' }],
    };
    const childCommand = {
      type: 'commandExecution',
      id: 'exec-child',
      command: "/bin/bash -lc 'git status'",
      commandActions: [{ type: 'unknown', command: 'git status' }],
      status: 'inProgress',
    };
    const items = [
      codexItem({ type: 'turn.started' }),
      codexItem({ type: 'item.started', item: spawn }),
      codexItem({ type: 'item.completed', item: spawn }),
      codexItem({ type: 'codex.subAgentStatus', parentToolUseId: 'call_spawn', working: true }),
      codexItem({ type: 'item.started', item: childCommand, parentToolUseId: 'call_spawn' }),
      codexItem({
        type: 'item.completed',
        item: { ...childCommand, status: 'completed' },
        parentToolUseId: 'call_spawn',
      }),
      codexItem({ type: 'codex.subAgentStatus', parentToolUseId: 'call_spawn', working: false }),
    ];
    const state = createNormState({ harness: 'codex' });
    const agent = agentEvents(replay(items, state));
    expect(trace(agent)).toEqual([
      'turnStart',
      'toolStart:Agent',
      'subagentStart:Bash',
      'subagentEnd',
      'toolEnd',
    ]);
    const start = agent.find((e) => e.kind === 'toolStart');
    expect(start).toMatchObject({
      runInBackground: true,
      input: { description: 'Ohm (pr_inventory)' },
    });
    expect(formatConductorToolStatus('Agent', { description: 'Ohm (pr_inventory)' })).toBe(
      'Subtask: Ohm (pr_inventory)',
    );
  });
});

describe('harness detection and tool vocabulary', () => {
  it('detects the harness from the payload shape first', () => {
    const claudeInit = fixture('claude-turn.json').find(
      (i) => (i.content.rawPayload as { subtype?: string } | undefined)?.subtype === 'init',
    );
    const cursorInit = fixture('cursor-turn.json')[1];
    const codexItem = fixture('codex-turn.json')[1];
    const orchestratorReport = fixture('orchestrator-spawn-claude.json')[13];
    expect(claudeInit && detectHarness(claudeInit)).toBe('claude');
    expect(detectHarness(cursorInit)).toBe('cursor');
    expect(detectHarness(codexItem, 'claude-opus-5-5[1m]')).toBe('codex');
    // A CLI-sent message carries no config.harness: fall back to the model.
    expect(detectHarness(orchestratorReport)).toBeUndefined();
    expect(detectHarness(orchestratorReport, 'gpt-6.1-sol')).toBe('codex');
    expect(detectHarness(orchestratorReport, 'grok-4.7')).toBe('cursor');
  });

  it('maps raw tool names onto the canonical vocabulary and formats Conductor-only tools', () => {
    expect(conductorToolName('grep')).toBe('Grep');
    expect(conductorToolName('updateTodos')).toBe('TodoWrite');
    expect(conductorToolName('readLints')).toBe('Read');
    expect(conductorToolName('delete')).toBe('Write');
    expect(conductorToolName('mcp__conductor__AskUserQuestion')).toBe('AskUserQuestion');
    expect(conductorToolName('constructor')).toBe('constructor');
    expect(formatConductorToolStatus('TodoWrite', {})).toBe('Updating todos');
    expect(formatConductorToolStatus('Sleep', {})).toBe('Waiting');
    expect(formatConductorToolStatus('Monitor', { description: 'deploy logs' })).toBe(
      'Watching: deploy logs',
    );
    expect(formatConductorToolStatus('Read', { paths: ['src/a/b.ts'] })).toBe('Reading b.ts');
    expect(formatConductorToolStatus('AskUserQuestion', {})).toBe('Waiting for your answer');
    expect(CONDUCTOR_READING_TOOLS.has('ToolSearch')).toBe(true);
    expect(CONDUCTOR_READING_TOOLS.has('Monitor')).toBe(true);
    expect(CONDUCTOR_READING_TOOLS.has('Read')).toBe(true);
  });

  it('unwraps the bash -lc wrapper Codex puts around commands', () => {
    expect(unwrapShellCommand("/bin/bash -lc 'git diff --stat'")).toBe('git diff --stat');
    expect(unwrapShellCommand("/bin/bash -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
    expect(unwrapShellCommand('bash -c "ls -la"')).toBe('ls -la');
    expect(unwrapShellCommand('npm test')).toBe('npm test');
  });
});
