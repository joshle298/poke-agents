import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import type { AgentLinkEvent } from '../../core/src/provider.js';
import {
  LinkTracker,
  parseCliOutput,
  parseConductorCommands,
  splitShellCommands,
} from '../src/providers/stream/conductor/links.js';
import type { ConductorItem } from '../src/providers/stream/conductor/types.js';

const FIXTURES = path.join(__dirname, 'fixtures', 'conductor');

function fixture(name: string): ConductorItem[] {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf-8')) as ConductorItem[];
}

const readme = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'README.json'), 'utf-8')) as {
  sessions: Record<string, string>;
  messageIds: Record<string, string>;
  expectedEdges: Array<{ from: string; to: string; kind: string; messageId?: string }>;
};
const ORCH = readme.sessions.S_ORCH;
const CHILD = readme.sessions.S_CHILD;

function feed(tracker: LinkTracker, items: ConductorItem[], live = false): AgentLinkEvent[] {
  return items.flatMap((item) =>
    tracker.observe(item.sessionId, item, { live }).emit.map((e) => e.event),
  );
}

function edgeSet(tracker: LinkTracker) {
  return tracker
    .allEdges()
    .map((e) => ({ from: e.from, to: e.to, kind: e.kind, messageId: e.messageId }))
    .sort((a, b) => `${a.kind}${a.messageId}`.localeCompare(`${b.kind}${b.messageId}`));
}

const expected = readme.expectedEdges
  .map((e) => ({ from: e.from, to: e.to, kind: e.kind, messageId: e.messageId }))
  .sort((a, b) => `${a.kind}${a.messageId}`.localeCompare(`${b.kind}${b.messageId}`));

describe('session links over the orchestrator and child fixtures', () => {
  it('produces exactly the expected edges, each emitted once (orchestrator first)', () => {
    const tracker = new LinkTracker();
    const emitted = [
      ...feed(tracker, fixture('orchestrator-spawn-claude.json')),
      ...feed(tracker, fixture('child-first-message.json')),
    ];
    expect(edgeSet(tracker)).toEqual(expected);
    const label = (e: AgentLinkEvent) => `${e.kind}:${e.fromSessionId}>${e.toSessionId}`;
    expect(emitted.map(label).sort()).toEqual(
      [
        `messaged:${CHILD}>${ORCH}`,
        `messaged:${ORCH}>${CHILD}`,
        `spawned:${ORCH}>${CHILD}`,
        `watched:${ORCH}>${CHILD}`,
      ].sort(),
    );
    expect(emitted.every((e) => e.live === false)).toBe(true);
  });

  it('produces the same edges when the child is read first, and prefers receiver previews', () => {
    const tracker = new LinkTracker();
    const emitted = [
      ...feed(tracker, fixture('child-first-message.json')),
      ...feed(tracker, fixture('orchestrator-spawn-claude.json')),
    ];
    expect(edgeSet(tracker)).toEqual(expected);
    expect(emitted).toHaveLength(4);
    const spawn = emitted.find((e) => e.kind === 'spawned');
    expect(spawn).toMatchObject({
      fromSessionId: ORCH,
      toSessionId: CHILD,
      preview: 'You are Worker A. Review the change and report back to the orchestrator.',
    });
    const merged = tracker.allEdges().find((e) => e.kind === 'spawned');
    expect(merged?.evidence.sort()).toEqual(['senderSessionId', 'toolCall', 'toolOutput']);
  });

  it('aggregates two watch calls in one Bash into one watched emission', () => {
    const tracker = new LinkTracker();
    feed(tracker, fixture('orchestrator-spawn-claude.json'));
    const watched = tracker.allEdges().filter((e) => e.kind === 'watched');
    expect(watched).toHaveLength(1);
    expect(watched[0]).toMatchObject({ from: ORCH, to: CHILD, count: 1 });
  });

  it('replaying the same items emits nothing new', () => {
    const tracker = new LinkTracker();
    feed(tracker, fixture('orchestrator-spawn-claude.json'));
    feed(tracker, fixture('child-first-message.json'));
    const again = [
      ...feed(tracker, fixture('orchestrator-spawn-claude.json')),
      ...feed(tracker, fixture('child-first-message.json')),
    ];
    expect(again).toEqual([]);
  });

  it('reads a Codex orchestrator: session create JSON output and a watch', () => {
    const tracker = new LinkTracker();
    const items = fixture('orchestrator-commands-codex.json');
    const emitted = feed(tracker, items, true);
    const from = items[0].sessionId;
    const workerB = '5e5510cc-0000-4000-8000-000000000012';
    expect(emitted.map((e) => [e.kind, e.fromSessionId, e.toSessionId])).toEqual([
      ['spawned', from, workerB],
      ['watched', from, workerB],
    ]);
    const spawn = tracker.allEdges().find((e) => e.kind === 'spawned');
    expect(spawn).toMatchObject({
      messageId: '3e553e55-0000-4000-8000-000000000004',
      toWorkspaceId: '0000bbbb-0000-4000-8000-000000000002',
    });
    expect(emitted.every((e) => e.live)).toBe(true);
  });
});

describe('merge rules', () => {
  const at = (s: number) =>
    `2026-01-01T12:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000Z`;
  const S = '11111111-0000-4000-8000-000000000001';
  const R = '22222222-0000-4000-8000-000000000002';

  function bash(id: string, command: string, seconds: number): ConductorItem {
    return {
      id: `use-${id}`,
      sessionId: S,
      sessionIndex: seconds,
      type: 'agent',
      content: {
        rawPayload: {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
        },
      },
      receivedAt: at(seconds),
    };
  }
  function result(id: string, output: string, seconds: number, isError = false): ConductorItem {
    return {
      id: `res-${id}`,
      sessionId: S,
      sessionIndex: seconds + 1,
      type: 'agent',
      content: {
        rawPayload: {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: isError }],
          },
        },
      },
      receivedAt: at(seconds),
    };
  }
  function received(messageId: string, index: number, seconds: number): ConductorItem {
    return {
      id: `rx-${messageId}`,
      sessionId: R,
      sessionIndex: index,
      type: 'userMessage',
      content: { id: messageId, senderSessionId: S, message: 'hello from S', state: 'sent' },
      receivedAt: at(seconds),
    };
  }

  it('merges a sender edge without a message id with the receiver edge within 120 s', () => {
    const tracker = new LinkTracker();
    const sent = [
      ...feed(tracker, [
        bash('t1', `conductor message create --session ${R} --message "hello from S"`, 10),
      ]),
      ...feed(tracker, [result('t1', 'queued', 11)]),
    ];
    expect(sent).toHaveLength(1);
    const rx = feed(tracker, [received('33333333-0000-4000-8000-000000000003', 5, 70)]);
    expect(rx).toEqual([]);
    expect(tracker.allEdges()).toHaveLength(1);
  });

  it('keeps distinct messages apart outside the merge window', () => {
    const tracker = new LinkTracker();
    feed(tracker, [bash('t1', `conductor message create --session ${R} --message hi`, 10)]);
    feed(tracker, [result('t1', 'queued', 11)]);
    const rx = feed(tracker, [received('33333333-0000-4000-8000-000000000003', 5, 400)]);
    expect(rx).toHaveLength(1);
    expect(tracker.allEdges()).toHaveLength(2);
  });

  it('does not create an edge for a failed CLI call', () => {
    const tracker = new LinkTracker();
    feed(tracker, [bash('t1', `conductor message create --session ${R} --message hi`, 10)]);
    const out = feed(tracker, [result('t1', 'error: Session not found (HTTP 404)', 11)]);
    expect(out).toEqual([]);
    expect(tracker.allEdges()).toEqual([]);
  });

  it('drops a pending spawn whose target never resolved after 10 minutes', () => {
    const tracker = new LinkTracker();
    feed(tracker, [bash('t1', 'conductor workspace create --name W --message-file /tmp/m.md', 10)]);
    feed(tracker, [result('t1', 'Workspace created', 11)]);
    expect(tracker.allEdges()).toEqual([]);
    // A receiver spawn edge inside the window merges with the pending one.
    const rx = feed(tracker, [received('44444444-0000-4000-8000-000000000004', 1, 60)]);
    expect(rx).toHaveLength(1);
    expect(tracker.allEdges()[0].evidence.sort()).toEqual(['senderSessionId', 'toolCall']);

    const later = new LinkTracker();
    feed(later, [bash('t2', 'conductor workspace create --name W --message-file /tmp/m.md', 10)]);
    feed(later, [result('t2', 'Workspace created', 11)]);
    later.prune(Date.parse(at(11)) + 10 * 60_000 + 1);
    const rx2 = feed(later, [received('55555555-0000-4000-8000-000000000005', 1, 60)]);
    expect(rx2).toHaveLength(1);
    expect(later.allEdges()[0].evidence).toEqual(['senderSessionId']);
  });
});

describe('CLI parsing', () => {
  it('splits shell commands on separators but not inside quotes', () => {
    expect(splitShellCommands(`a b; c "d; e" && f | g\nh 'i && j'`)).toEqual([
      ['a', 'b'],
      ['c', 'd; e'],
      ['f'],
      ['g'],
      ['h', 'i && j'],
    ]);
  });

  it('recognizes every verb, global flags, wrappers and nested bash -lc', () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000001';
    const other = 'bbbbbbbb-0000-4000-8000-000000000002';
    expect(parseConductorCommands(`conductor --json session status ${id}`)).toEqual([
      { verb: 'session.status', kind: 'watched', targetSessionId: id },
    ]);
    expect(
      parseConductorCommands(`conductor session message ${id} --after ${other} --json`),
    ).toEqual([{ verb: 'session.message', kind: 'watched', targetSessionId: id }]);
    expect(parseConductorCommands(`FOO=1 conductor session cancel ${id}`)[0]).toMatchObject({
      verb: 'session.cancel',
      kind: 'watched',
    });
    expect(
      parseConductorCommands(
        `bash -lc 'conductor message create --session ${id} --message "ship it"'`,
      ),
    ).toEqual([
      {
        verb: 'message.create',
        kind: 'messaged',
        targetSessionId: id,
        messageId: undefined,
        preview: 'ship it',
      },
    ]);
    expect(
      parseConductorCommands(
        `conductor session create --workspace ${other} --agent codex --session-id ${id} --message-id ${other}`,
      )[0],
    ).toMatchObject({
      verb: 'session.create',
      targetSessionId: id,
      targetWorkspaceId: other,
      messageId: other,
    });
    expect(parseConductorCommands(`echo conductor message create --session ${id}`)).toEqual([]);
    expect(parseConductorCommands(`python3 -c "subprocess.run(['conductor','--json'])"`)).toEqual(
      [],
    );
    expect(parseConductorCommands('conductor workspace list --mine')).toEqual([]);
  });

  it('parses JSON and text CLI output into ordered records', () => {
    const ws = 'cccccccc-0000-4000-8000-000000000003';
    const sid = 'dddddddd-0000-4000-8000-000000000004';
    const mid = 'eeeeeeee-0000-4000-8000-000000000005';
    const text = [
      `Workspace ID   ${ws}`,
      `Session ID     ${sid}`,
      `Message ID     ${mid}`,
      'Message state  queued',
      `Deep link      conductor://workspace?id=${ws}&session=${sid}`,
    ].join('\n');
    expect(parseCliOutput(text)).toEqual([
      {
        workspaceId: ws,
        sessionId: sid,
        messageId: mid,
        deepLink: `conductor://workspace?id=${ws}&session=${sid}`,
      },
    ]);
    const json = `{"messageId":"${mid}","state":"queued","deepLink":"conductor-alpha://workspace?id=${ws}&session=${sid}"}`;
    expect(parseCliOutput(`noise\n${json}\n`)).toEqual([
      {
        sessionId: sid,
        workspaceId: ws,
        messageId: mid,
        deepLink: `conductor-alpha://workspace?id=${ws}&session=${sid}`,
      },
    ]);
  });
});
