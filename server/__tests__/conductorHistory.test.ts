/**
 * The Pokédex chat view's server half: older pages of a session's
 * conversation (getSessionHistory), the question a session is waiting on
 * (sessionDetail.question), and the keys and tool names entries carry so the
 * office can merge pages with the live entries.
 */

import { describe, expect, it } from 'vitest';

import { historyEntries, parseHistoryCursor } from '../src/providers/stream/conductor/history.js';
import type { ConductorItem } from '../src/providers/stream/conductor/types.js';
import {
  boot,
  CHILD,
  fixture,
  idleFeed,
  NOW,
  ORCH,
  retime,
  uuid,
  WS_ORCH,
} from './fixtures/conductor/pollerHarness.js';

const MINUTE = 60_000;

function longFeed(id: string, turns: number, endMs: number): ConductorItem[] {
  const turn = fixture('claude-turn.json');
  const items: ConductorItem[] = [];
  for (let k = 0; k < turns; k++) {
    for (const item of retime(turn, id, endMs - (turns - 1 - k) * MINUTE)) {
      items.push({ ...item, id: `${item.id}-t${k}`, sessionIndex: k * 19 + item.sessionIndex });
    }
  }
  return items;
}

async function bootWith(id: string, items: ConductorItem[], status: 'idle' | 'working' = 'idle') {
  const ws = uuid(0x9900);
  return boot({
    prepare: (api) => {
      api.addWorkspace({ id: ws, lastActivityAt: items.at(-1)?.receivedAt });
      api.addSession({ id, workspaceId: ws, items, status: { status } });
    },
  });
}

describe('history entries', () => {
  it('normalizes a page into user, tool, assistant and peer entries with stable keys', () => {
    const items = fixture('orchestrator-spawn-claude.json');
    const entries = historyEntries(ORCH, items, { harness: 'claude' });
    const roles = entries.map((e) => e.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    expect(roles).toContain('peerIn');
    const tools = entries.filter((e) => e.role === 'tool');
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((e) => typeof e.toolName === 'string' && e.key?.startsWith('tool:'))).toBe(
      true,
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ role: 'peerOut', peerSessionId: CHILD }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        role: 'peerIn',
        peerSessionId: CHILD,
        text: 'Worker A report: review finished, 2 findings.',
      }),
    );
    // Oldest first, every entry keyed, no key twice.
    const times = entries.map((e) => e.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const keys = entries.map((e) => e.key);
    expect(keys.every((k) => typeof k === 'string')).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('accepts only the cursors it issues', () => {
    expect(parseHistoryCursor('o150')).toBe(150);
    expect(parseHistoryCursor('o0')).toBe(0);
    for (const bad of ['150', 'o-1', 'o1.5', 'x150', '', 'o1234567890', 42, undefined]) {
      expect(parseHistoryCursor(bad)).toBeUndefined();
    }
  });
});

describe('getSessionHistory', () => {
  it('pages back through the whole feed, oldest first, on demand', async () => {
    const id = uuid(0x9901);
    // 14 turns of 18 items = 252 items.
    const h = await bootWith(id, longFeed(id, 14, NOW - 5 * MINUTE));
    const pages: Array<{ entries: unknown[]; before?: string; hasMore: boolean }> = [];
    let before: string | undefined;
    const calls = h.api.callsTo(`/sessions/${id}/messages`).length;
    do {
      const page = await h.provider.getSessionHistory(id, before);
      pages.push(page);
      before = page.before;
    } while (before !== undefined);

    expect(pages.map((p) => [p.before, p.hasMore])).toEqual([
      ['o152', true],
      ['o52', true],
      [undefined, false],
    ]);
    // One request per page, nothing else.
    const pageCalls = h.api.callsTo(`/sessions/${id}/messages`).slice(calls);
    expect(pageCalls.map((c) => [c.query.offset, c.query.limit])).toEqual([
      ['152', '100'],
      ['52', '100'],
      ['0', '52'],
    ]);
    // Every user message of the feed appears exactly once across the pages.
    const users = pages
      .flatMap((p) => p.entries)
      .filter((e) => (e as { role: string }).role === 'user');
    expect(users).toHaveLength(14);
    await h.provider.stop();
  });

  it('keys the newest page like the live Pokédex entries, so the two merge', async () => {
    const h = await boot({
      prepare: (api) => {
        api.addWorkspace({ id: WS_ORCH, lastActivityAt: new Date(NOW).toISOString() });
        api.addSession({
          id: ORCH,
          workspaceId: WS_ORCH,
          items: fixture('orchestrator-spawn-claude.json'),
        });
      },
    });
    const detail = await h.provider.getSessionDetail(ORCH);
    const page = await h.provider.getSessionHistory(ORCH);
    const pageKeys = new Set(page.entries.map((e) => e.key));
    const liveKeys = (detail?.entries ?? []).map((e) => e.key);
    expect(liveKeys.length).toBeGreaterThan(0);
    expect(liveKeys.filter((k) => !pageKeys.has(k))).toEqual([]);
    await h.provider.stop();
  });

  it('refuses a cursor it never issued and a session it does not know', async () => {
    const id = uuid(0x9902);
    const h = await bootWith(id, idleFeed(id, NOW - MINUTE));
    await expect(h.provider.getSessionHistory(id, '../../x')).rejects.toThrow(/cursor/i);
    await expect(h.provider.getSessionHistory(uuid(0xdead))).rejects.toThrow('Session not found');
    await h.provider.stop();
  });
});

describe('sessionDetail.question', () => {
  it('shows an open AskUserQuestion with its options', async () => {
    const id = uuid(0x9a01);
    const items = retime(fixture('wait-ask-user-question-pending.json'), id, NOW - MINUTE);
    const h = await bootWith(id, items, 'working');
    expect((await h.provider.getSessionDetail(id))?.question).toEqual({
      kind: 'askUser',
      text: 'Which option should we use?',
      options: ['Option A', 'Option B'],
    });
    await h.provider.stop();
  });

  it('drops the question once it was answered', async () => {
    const id = uuid(0x9a02);
    const items = retime(
      [
        ...fixture('wait-ask-user-question-pending.json'),
        ...fixture('wait-ask-user-question-answered-tail.json'),
      ],
      id,
      NOW - MINUTE,
    );
    const h = await bootWith(id, items);
    const detail = await h.provider.getSessionDetail(id);
    expect(detail).not.toBeNull();
    expect(detail?.question).toBeUndefined();
    await h.provider.stop();
  });

  it('shows a plan waiting for approval', async () => {
    const id = uuid(0x9a03);
    const items = retime(fixture('wait-plan-approval-pending.json'), id, NOW - MINUTE);
    const h = await bootWith(id, items, 'working');
    expect((await h.provider.getSessionDetail(id))?.question).toEqual({
      kind: 'plan',
      text: '# Plan\n1. Step one\n2. Step two',
    });
    await h.provider.stop();
  });

  it("shows a Codex agent's async question until the next user message", async () => {
    const id = uuid(0x9a04);
    const items = retime(fixture('wait-codex-async-question.json'), id, NOW - MINUTE);
    const h = await bootWith(id, items, 'working');
    expect((await h.provider.getSessionDetail(id))?.question).toEqual({
      kind: 'notice',
      text: 'Please sign in on your Mac so local captures can run. Other work continues meanwhile.',
    });
    await h.provider.stop();
  });
});
