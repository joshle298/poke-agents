import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { AgentState } from '../src/types.js';

// Isolate ~/.pixel-agents (server registry, token, seats) per test.
let tmpHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

const { agentCreatedMessage, agentDetailsMessage } = await import('../src/agentMessages.js');
const { createAgentState } = await import('../src/agentState.js');
const { AgentStateStore } = await import('../src/agentStateStore.js');
const { FileStateAdapter } = await import('../src/fileStateAdapter.js');
const { PixelAgentsServer } = await import('../src/server.js');

function conductorAgent(overrides: Partial<AgentState> = {}): AgentState {
  return createAgentState({
    id: 5,
    sessionId: 'conductor:5d0c',
    isExternal: true,
    projectDir: '',
    jsonlFile: '',
    hooksOnly: true,
    providerId: 'conductor',
    label: 'Fix the flaky test',
    directoryName: 'example-repo',
    palette: 2,
    hueShift: 0,
    species: 25,
    shiny: true,
    level: 12,
    leadAgentId: 3,
    agentName: 'Fix the flaky test',
    details: {
      repo: 'example-org/example-repo',
      workspaceId: 'w1',
      workspaceNumber: 7,
      messageCount: 40,
    },
    ...overrides,
  });
}

describe('agentCreatedMessage', () => {
  it('carries every AgentCreated field, including the saved seat', () => {
    expect(agentCreatedMessage(5, conductorAgent(), 'chair-1')).toEqual({
      type: 'agentCreated',
      id: 5,
      directoryName: 'example-repo',
      isExternal: true,
      palette: 2,
      hueShift: 0,
      isTeammate: true,
      teammateName: 'Fix the flaky test',
      parentAgentId: 3,
      teamName: undefined,
      hooksOnly: true,
      providerId: 'conductor',
      label: 'Fix the flaky test',
      seatId: 'chair-1',
      species: 25,
      shiny: true,
      level: 12,
    });
  });

  it('keeps the upstream shape for a plain Claude agent', () => {
    const agent = createAgentState({
      id: 1,
      sessionId: 'abc',
      isExternal: false,
      projectDir: '/p',
      jsonlFile: '/p/abc.jsonl',
      palette: 1,
      hueShift: 90,
    });
    const msg = agentCreatedMessage(1, agent);
    expect(msg).toMatchObject({ type: 'agentCreated', id: 1, palette: 1, hueShift: 90 });
    expect(msg.isExternal).toBeUndefined();
    expect(msg.isTeammate).toBeUndefined();
    expect(msg.hooksOnly).toBeUndefined();
    expect(msg.seatId).toBeUndefined();
  });
});

describe('agentDetailsMessage', () => {
  it('maps provider details onto the Conductor fields', () => {
    expect(agentDetailsMessage(5, conductorAgent())).toMatchObject({
      type: 'agentDetails',
      id: 5,
      providerId: 'conductor',
      label: 'Fix the flaky test',
      conductorSessionId: '5d0c',
      conductorWorkspaceId: 'w1',
      conductorWorkspaceNumber: 7,
      repo: 'example-org/example-repo',
      messageCount: 40,
      species: 25,
      shiny: true,
      level: 12,
    });
  });

  it('has nothing to say about a plain Claude agent', () => {
    const agent = createAgentState({
      id: 1,
      sessionId: 'abc',
      isExternal: false,
      projectDir: '/p',
      jsonlFile: '/p/abc.jsonl',
    });
    expect(agentDetailsMessage(1, agent)).toBeNull();
    agent.species = 4;
    expect(agentDetailsMessage(1, agent)).toMatchObject({ species: 4 });
    expect(agentDetailsMessage(1, agent)!.conductorSessionId).toBeUndefined();
  });
});

describe('standalone agentCreated over /ws', () => {
  let server: InstanceType<typeof PixelAgentsServer>;
  let socket: WebSocket | null = null;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-agent-created-'));
    server = new PixelAgentsServer();
  });

  afterEach(() => {
    socket?.terminate();
    server.stop();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('announces an agent adopted after the client connected in its saved seat', async () => {
    const store = new AgentStateStore();
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    store.setAdapter(adapter);
    adapter.saveSeats({ '5': { palette: 2, hueShift: 0, seatId: 'chair-1' } });
    const config = await server.start({ embedded: false, store });

    socket = new WebSocket(`ws://127.0.0.1:${config.port.toString()}/ws`);
    const created = new Promise<Record<string, unknown>>((resolve) => {
      socket!.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type === 'agentCreated') resolve(msg);
      });
    });
    await new Promise<void>((resolve) => socket!.on('open', () => resolve()));

    store.set(5, conductorAgent());
    expect(await created).toMatchObject({
      id: 5,
      seatId: 'chair-1',
      providerId: 'conductor',
      label: 'Fix the flaky test',
      species: 25,
      shiny: true,
      level: 12,
    });
  });
});
