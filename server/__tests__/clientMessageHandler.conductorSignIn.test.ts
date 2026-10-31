import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { type ClientMessageContext, handleClientMessage } from '../src/clientMessageHandler.js';
import {
  type ConductorSignInControl,
  SignInError,
} from '../src/providers/stream/conductor/signIn.js';

type Message = Record<string, unknown>;

const KEY = `pa_${'fake'.repeat(11)}`;

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function control(overrides: Partial<ConductorSignInControl> = {}): ConductorSignInControl & {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  return {
    connect: vi.fn(async () => ({ message: 'Connected as user@example.com' })),
    disconnect: vi.fn(async () => ({ message: 'Signed out.' })),
    ...overrides,
  } as never;
}

function harness(opts: { privileged: boolean; signIn?: ConductorSignInControl }) {
  const sent: Message[] = [];
  const ctx: ClientMessageContext = {
    store: new AgentStateStore(),
    cache: null,
    privileged: opts.privileged,
    conductorSignIn: opts.signIn,
  };
  const send = (message: Message) => handleClientMessage(message, (m) => sent.push(m), ctx);
  return { sent, send };
}

/** Everything a test could observe leaving the process. */
function captureConsole() {
  const lines: string[] = [];
  for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  }
  return lines;
}

afterEach(() => vi.restoreAllMocks());

describe('connectConductor and disconnectConductor', () => {
  it('refuse a read-only office without calling the controller', async () => {
    const signIn = control();
    const logs = captureConsole();
    const h = harness({ privileged: false, signIn });
    h.send({ type: 'connectConductor', apiKey: KEY });
    h.send({ type: 'disconnectConductor' });
    await settle();
    expect(signIn.connect).not.toHaveBeenCalled();
    expect(signIn.disconnect).not.toHaveBeenCalled();
    expect(h.sent).toEqual([
      {
        type: 'conductorActionResult',
        action: 'connect',
        ok: false,
        message: 'Read-only office: open the tokened URL to make changes.',
      },
      {
        type: 'conductorActionResult',
        action: 'disconnect',
        ok: false,
        message: 'Read-only office: open the tokened URL to make changes.',
      },
    ]);
    expect(JSON.stringify(h.sent)).not.toContain(KEY);
    expect(logs.join('\n')).not.toContain(KEY);
  });

  it('connects a privileged office and never echoes the key', async () => {
    const signIn = control();
    const logs = captureConsole();
    const h = harness({ privileged: true, signIn });
    h.send({ type: 'connectConductor', apiKey: KEY });
    await settle();
    expect(signIn.connect).toHaveBeenCalledWith(KEY);
    expect(h.sent).toEqual([
      {
        type: 'conductorActionResult',
        action: 'connect',
        ok: true,
        message: 'Connected as user@example.com',
      },
    ]);
    expect(JSON.stringify(h.sent)).not.toContain(KEY);
    expect(logs.join('\n')).not.toContain(KEY);
  });

  it('rejects oversize and non-string keys before the controller sees them', async () => {
    const signIn = control();
    const h = harness({ privileged: true, signIn });
    h.send({ type: 'connectConductor', apiKey: 'x'.repeat(1001) });
    h.send({ type: 'connectConductor', apiKey: { nested: KEY } });
    h.send({ type: 'connectConductor' });
    await settle();
    expect(signIn.connect).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(3);
    for (const reply of h.sent) {
      expect(reply).toMatchObject({
        action: 'connect',
        ok: false,
        message: "That doesn't look like a Conductor API key.",
      });
    }
  });

  it('passes on the controller’s refusals, and hides unexpected errors', async () => {
    const logs = captureConsole();
    const refused = harness({
      privileged: true,
      signIn: control({
        connect: vi.fn(async () => {
          throw new SignInError('That key was rejected by Conductor.');
        }),
      }),
    });
    refused.send({ type: 'connectConductor', apiKey: KEY });
    const broken = harness({
      privileged: true,
      signIn: control({
        connect: vi.fn(async () => {
          // An error whose text quotes the request must never reach a reply or a log.
          throw new Error(`boom Bearer ${KEY}`);
        }),
        disconnect: vi.fn(async () => {
          throw new Error(`boom ${KEY}`);
        }),
      }),
    });
    broken.send({ type: 'connectConductor', apiKey: KEY });
    broken.send({ type: 'disconnectConductor' });
    await settle();
    expect(refused.sent).toEqual([
      {
        type: 'conductorActionResult',
        action: 'connect',
        ok: false,
        message: 'That key was rejected by Conductor.',
      },
    ]);
    expect(broken.sent).toEqual([
      {
        type: 'conductorActionResult',
        action: 'connect',
        ok: false,
        message: "Couldn't connect to Conductor.",
      },
      {
        type: 'conductorActionResult',
        action: 'disconnect',
        ok: false,
        message: "Couldn't sign out of Conductor.",
      },
    ]);
    expect(logs.join('\n')).not.toContain(KEY);
    expect(logs.join('\n')).toContain('Conductor connect failed unexpectedly (Error)');
  });

  it('answers that connecting is unavailable where no controller runs (VS Code, --no-conductor)', async () => {
    const h = harness({ privileged: true });
    h.send({ type: 'connectConductor', apiKey: KEY });
    h.send({ type: 'disconnectConductor' });
    await settle();
    expect(h.sent.map((m) => [m.action, m.ok, m.message])).toEqual([
      ['connect', false, 'Connecting to Conductor is not available in this office.'],
      ['disconnect', false, 'Connecting to Conductor is not available in this office.'],
    ]);
  });
});
