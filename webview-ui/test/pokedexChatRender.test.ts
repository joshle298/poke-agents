/**
 * The Pokédex chat tab rendered to static markup (react-dom/server, no DOM):
 * conversation text stays plain text, markdown links read as their text, a
 * pending question offers its options as honest "Reply with this option"
 * buttons, and a turn's tools collapse into one line. Synthetic text only.
 *
 * Run with: npm test
 */

import type { FunctionComponent, ReactNode } from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionDetail } from '../../core/src/messages.js';
import type { ChatHistory } from '../src/conductor/conductorStore.js';

/** PokedexChat's props. The test tsconfig has no JSX or DOM lib, so the
 *  .tsx module is imported untyped and described here. */
interface ChatProps {
  agentId: number;
  agentName: string;
  detail: SessionDetail | undefined;
  history: ChatHistory | undefined;
  now: number;
  canAct: boolean;
  sending: boolean;
  onReply: (text: string) => void;
  replyBox: ReactNode;
  isInOffice: (agentId: number) => boolean;
  onJump: (agentId: number) => void;
}
const CHAT_MODULE = '../src/components/PokedexChat.js';
let PokedexChat: FunctionComponent<ChatProps>;

beforeAll(async () => {
  // The component's module graph reaches the transport, which reads the
  // page's location at import time.
  vi.stubGlobal('window', {
    location: { protocol: 'http:', host: 'localhost:41510', search: '' },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  ({ PokedexChat } = (await import(/* @vite-ignore */ CHAT_MODULE)) as {
    PokedexChat: FunctionComponent<ChatProps>;
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const NOW = 10_000_000;

function detail(patch: Partial<SessionDetail> = {}): SessionDetail {
  return {
    type: 'sessionDetail',
    id: 2,
    entries: [
      {
        role: 'user',
        text: 'Read @[Planning notes.md](.context%2Fattachments%2Fnotes.md) first',
        at: NOW - 300_000,
        key: 'k1',
      },
      { role: 'tool', text: 'Reading notes.md', toolName: 'Read', at: NOW - 240_000, key: 'k2' },
      { role: 'tool', text: 'Running npm test', toolName: 'Bash', at: NOW - 200_000, key: 'k3' },
      {
        role: 'assistant',
        text: 'Done. <img src=x onerror=alert(1)> is just text.',
        at: NOW - 120_000,
        key: 'k4',
      },
      {
        role: 'peerIn',
        text: 'How far along?',
        at: NOW - 60_000,
        key: 'k5',
        peerId: 1,
        peerLabel: 'Plan the refactor',
      },
    ],
    ...patch,
  };
}

function render(props: {
  detail?: SessionDetail;
  history?: ChatHistory;
  canAct?: boolean;
  sending?: boolean;
}) {
  return renderToStaticMarkup(
    createElement(PokedexChat, {
      agentId: 2,
      agentName: 'Sparky',
      detail: props.detail,
      history: props.history,
      now: NOW,
      canAct: props.canAct ?? true,
      sending: props.sending ?? false,
      onReply: () => {},
      replyBox: createElement('div', { id: 'reply-box' }),
      isInOffice: (id: number) => id === 1,
      onJump: () => {},
    }),
  );
}

describe('PokedexChat', () => {
  it('renders the conversation as plain text, links as their text', () => {
    const html = render({ detail: detail() });
    expect(html).toContain('Read Planning notes.md first');
    expect(html).not.toContain('](');
    // Markup inside a message is escaped text, never an element.
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    // One collapsed line for the turn's tools, named.
    expect(html).toContain('2 tools · Read, Bash');
    expect(html).toContain('<details>');
    // The peer is a jump button while it is in the office.
    expect(html).toMatch(/From <button[^>]*>Plan the refactor<\/button>/);
    expect(html).toContain('Sparky');
    expect(html).toContain('id="reply-box"');
  });

  it('puts a pending question on top with honest option buttons', () => {
    const html = render({
      detail: detail({
        question: {
          kind: 'askUser',
          text: 'Keep the [query string](docs%2Fq.md)?',
          options: ['Keep it', 'Drop it', '  '],
        },
      }),
    });
    expect(html).toContain('aria-label="Pending question"');
    expect(html).toContain('Keep the query string?');
    expect(html.match(/Reply with this option/g)).toHaveLength(2);
    expect(html.indexOf('Pending question')).toBeLessThan(html.indexOf('Conversation'));
  });

  it('a view-only office shows the question without reply buttons or a reply box', () => {
    const html = render({
      detail: detail({ question: { kind: 'plan', text: 'Approve?', options: ['Yes'] } }),
      canAct: false,
    });
    expect(html).toContain('Plan to approve');
    expect(html).not.toContain('Reply with this option');
    expect(html).not.toContain('reply-box');
  });

  it('says Loading until the first reply, then Nothing yet when it is empty', () => {
    expect(render({})).toContain('Loading…');
    expect(render({ detail: detail({ entries: [] }) })).toContain('Nothing yet.');
  });

  it('offers Load earlier while older pages exist, and marks the start when none do', () => {
    const more: ChatHistory = { entries: [], cursor: 'c1', hasMore: true, loaded: true };
    expect(render({ detail: detail(), history: more })).toContain('Load earlier');
    const done: ChatHistory = { entries: [], hasMore: false, loaded: true };
    const html = render({ detail: detail(), history: done });
    expect(html).not.toContain('Load earlier');
    expect(html).toContain('Start of the conversation');
    const loading: ChatHistory = { ...more, pendingSince: NOW - 1_000 };
    expect(render({ detail: detail(), history: loading })).toContain('Loading…');
    const failed: ChatHistory = { ...more, error: 'Conductor is rate limiting this app.' };
    expect(render({ detail: detail(), history: failed })).toContain(
      'Couldn&#x27;t load earlier messages.',
    );
  });
});
