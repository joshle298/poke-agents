import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type {
  SessionDetail,
  SessionDetailEntry,
  SessionQuestion,
} from '../../../core/src/messages.js';
import { requestSessionHistory } from '../conductor/actions.js';
import type { ThreadItem } from '../conductor/chat.js';
import {
  buildThread,
  isNearBottom,
  mergeEntries,
  questionTitle,
  scrollTopAfterPrepend,
  toolGroupSummary,
  toolLabel,
} from '../conductor/chat.js';
import { plainText } from '../conductor/chatText.js';
import type { ChatHistory } from '../conductor/conductorStore.js';
import { conductorStore } from '../conductor/conductorStore.js';
import { shortAge } from '../conductor/format.js';
import { POKEDEX_CHAT_STICK_SLACK_PX, POKEDEX_HISTORY_TIMEOUT_MS } from '../constants.js';
import { Button } from './ui/Button.js';

/** Line height for wrapped prose (the pixel font's default leading is loose). */
const TEXT_LINE_HEIGHT = 1.3;

interface PeerProps {
  isInOffice: (agentId: number) => boolean;
  onJump: (agentId: number) => void;
}

/** The session another one messaged, as a jump button when it is in the office. */
function PeerName({ entry, isInOffice, onJump }: { entry: SessionDetailEntry } & PeerProps) {
  const peer = entry.peerId !== undefined && isInOffice(entry.peerId) ? entry.peerId : null;
  const name = entry.peerLabel ?? (peer !== null ? `Agent ${peer}` : 'another session');
  if (peer === null) return <>{name}</>;
  return (
    <button
      className="bg-transparent border-0 p-0 cursor-pointer underline text-accent text-2xs"
      onClick={() => onJump(peer)}
      title="Show this session"
    >
      {name}
    </button>
  );
}

function Prose({ text }: { text: string }) {
  return (
    <span
      className="block whitespace-pre-wrap break-words"
      style={{ lineHeight: TEXT_LINE_HEIGHT }}
    >
      {plainText(text)}
    </span>
  );
}

function ChatMessage({
  entry,
  agentName,
  now,
  ...peer
}: { entry: SessionDetailEntry; agentName: string; now: number } & PeerProps) {
  const mine = entry.role === 'user' || entry.role === 'peerOut';
  const isPeer = entry.role === 'peerIn' || entry.role === 'peerOut';
  const head: ReactNode =
    entry.role === 'user' ? (
      'You'
    ) : entry.role === 'assistant' ? (
      agentName
    ) : (
      <>
        {entry.role === 'peerIn' ? 'From ' : 'To '}
        <PeerName entry={entry} {...peer} />
      </>
    );
  return (
    <li className={`flex flex-col gap-2 text-xs ${mine ? 'items-end' : 'items-start'}`}>
      <span className="text-2xs text-text-muted">
        {head} · {shortAge(entry.at, now)}
      </span>
      <div
        className={`max-w-[92%] px-6 py-4 border-2 ${isPeer ? 'border-dashed' : ''} ${
          entry.role === 'user' ? 'bg-active-bg border-accent' : 'bg-btn-bg border-border'
        }`}
      >
        <Prose text={entry.text} />
      </div>
    </li>
  );
}

function ToolGroup({ entries, now }: { entries: SessionDetailEntry[]; now: number }) {
  const last = entries[entries.length - 1];
  return (
    <li className="text-2xs text-text-muted">
      <details>
        <summary className="cursor-pointer select-none">
          {toolGroupSummary(entries)} · {shortAge(last.at, now)}
        </summary>
        <ul className="m-0 mt-2 pl-12 list-none flex flex-col gap-2">
          {entries.map((entry, i) => (
            <li key={`${entry.key ?? entry.at}:${i}`} className="break-words">
              <span className="text-text">{toolLabel(entry)}</span>
              {entry.text ? ` · ${plainText(entry.text)}` : ''} · {shortAge(entry.at, now)}
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

/** The question a session is waiting on, with its options as plain replies. */
function QuestionCard({
  question,
  canReply,
  busy,
  onReply,
}: {
  question: SessionQuestion;
  canReply: boolean;
  busy: boolean;
  onReply: (text: string) => void;
}) {
  const options = (question.options ?? []).filter((o) => o.trim());
  const text = plainText(question.text);
  // Open by default; folding it to one line gives a short screen (a phone's
  // bottom sheet) its thread back.
  const [open, setOpen] = useState(true);
  return (
    <section
      aria-label="Pending question"
      className="shrink-0 mx-8 mt-6 border-2 border-accent bg-bg px-6 py-4 flex flex-col gap-4 max-h-[40%] overflow-y-auto pixel-scrollbar"
    >
      <button
        className="flex items-center gap-6 bg-transparent border-0 p-0 cursor-pointer text-left text-xs min-w-0"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Fold the question' : 'Show the question'}
      >
        <span className="text-accent shrink-0">{open ? '▾' : '▸'}</span>
        <span className="text-accent shrink-0">{questionTitle(question.kind)}</span>
        {!open && <span className="truncate text-text-muted min-w-0">{text}</span>}
      </button>
      {open && (
        <p
          className="m-0 text-xs whitespace-pre-wrap break-words"
          style={{ lineHeight: TEXT_LINE_HEIGHT }}
        >
          {text}
        </p>
      )}
      {open && options.length > 0 && (
        <ul className="m-0 p-0 list-none flex flex-col gap-4">
          {options.map((option, i) => (
            <li
              key={`${i}:${option}`}
              className="flex flex-wrap items-center justify-end gap-x-6 gap-y-2 border-t border-border pt-4"
            >
              <span
                className="flex-1 basis-[120px] min-w-0 text-xs whitespace-pre-wrap break-words"
                style={{ lineHeight: TEXT_LINE_HEIGHT }}
              >
                {plainText(option)}
              </span>
              {canReply && (
                <Button
                  size="sm"
                  className="shrink-0"
                  variant={busy ? 'disabled' : 'default'}
                  disabled={busy}
                  onClick={() => onReply(option.trim())}
                  title="Sends this option's text to the session as a message"
                >
                  Reply with this option
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface PokedexChatProps extends PeerProps {
  agentId: number;
  /** What the agent's own lines are headed with (its species, else its name). */
  agentName: string;
  detail: SessionDetail | undefined;
  history: ChatHistory | undefined;
  now: number;
  /** A privileged office and a stream agent: history paging and replies. */
  canAct: boolean;
  /** A send is in flight (option buttons wait). */
  sending: boolean;
  /** Send `text` to the session as a message. */
  onReply: (text: string) => void;
  /** The reply box, shared with the Overview tab (one draft). */
  replyBox: ReactNode;
  /** Changes on every send: the thread jumps to its newest line. */
  sentAt?: number;
}

/**
 * The Pokédex chat tab: the conversation, newest at the bottom, with older
 * pages on demand (requestSessionHistory), the pending question on top and
 * the reply box below. Plain text only.
 */
export function PokedexChat({
  agentId,
  agentName,
  detail,
  history,
  now,
  canAct,
  sending,
  onReply,
  replyBox,
  sentAt,
  isInOffice,
  onJump,
}: PokedexChatProps) {
  const entries = useMemo(
    () => mergeEntries(history?.entries, detail?.entries),
    [history?.entries, detail?.entries],
  );
  const thread = useMemo(() => buildThread(entries), [entries]);
  const pending =
    history?.pendingSince !== undefined && now - history.pendingSince < POKEDEX_HISTORY_TIMEOUT_MS;
  const failed = !pending && (history?.error !== undefined || history?.pendingSince !== undefined);

  // The newest page once per agent, for its cursor and the tool lines the
  // live detail collapses. A privileged office only (read-only is refused).
  useEffect(() => {
    if (!canAct) return;
    const known = conductorStore.getState().chatHistories[agentId];
    const inFlight =
      known?.pendingSince !== undefined &&
      Date.now() - known.pendingSince < POKEDEX_HISTORY_TIMEOUT_MS;
    if (known?.loaded || inFlight) return;
    requestSessionHistory(agentId);
  }, [agentId, canAct]);

  // Sticky scroll: follow new lines while the end is in view; keep the
  // reading position when older lines load above.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const anchorRef = useRef<{ scrollHeight: number; scrollTop: number; firstKey?: string } | null>(
    null,
  );
  const [unseen, setUnseen] = useState(false);
  const firstKey = thread[0]?.key;
  const lastKey = thread[thread.length - 1]?.key;
  const lastSize = thread.length;
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const anchor = anchorRef.current;
    if (anchor && firstKey !== anchor.firstKey) {
      el.scrollTop = scrollTopAfterPrepend(anchor, el.scrollHeight);
      anchorRef.current = null;
      return;
    }
    if (anchor && !pending) anchorRef.current = null;
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [firstKey, lastKey, lastSize, pending]);
  // A new line below while scrolled up: offer a jump to it.
  useEffect(() => {
    if (lastKey !== undefined && !stickRef.current) setUnseen(true);
  }, [lastKey]);

  // Sending a message brings the newest lines (and its reply) into view.
  useEffect(() => {
    if (sentAt === undefined) return;
    stickRef.current = true;
    setUnseen(false);
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sentAt]);

  const loadEarlier = () => {
    const el = scrollerRef.current;
    if (el)
      anchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, firstKey };
    requestSessionHistory(agentId);
  };
  const jumpToNewest = () => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setUnseen(false);
  };

  const topControl = (() => {
    if (!canAct) return null;
    if (pending) return <span className="text-2xs text-text-muted">Loading…</span>;
    if (failed) {
      return (
        <span className="flex items-center gap-6 text-2xs text-text-muted">
          Couldn&apos;t load earlier messages.
          <Button size="sm" onClick={loadEarlier}>
            Retry
          </Button>
        </span>
      );
    }
    if (history?.loaded && !history.hasMore) {
      return entries.length > 0 ? (
        <span className="text-2xs text-text-muted">Start of the conversation</span>
      ) : null;
    }
    return (
      <Button size="sm" onClick={loadEarlier}>
        Load earlier
      </Button>
    );
  })();

  // Nothing to show yet: still loading, empty, or a view-only office (its
  // requests are refused).
  const emptyText = !canAct
    ? "View-only offices can't load the conversation."
    : detail === undefined && !history?.loaded && !failed
      ? 'Loading…'
      : 'Nothing yet.';
  const showTopControl = topControl !== null && (thread.length > 0 || failed);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {detail?.question && (
        <QuestionCard
          question={detail.question}
          canReply={canAct}
          busy={sending}
          onReply={onReply}
        />
      )}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <div
          ref={scrollerRef}
          onScroll={(e) => {
            const near = isNearBottom(e.currentTarget, POKEDEX_CHAT_STICK_SLACK_PX);
            stickRef.current = near;
            if (near) setUnseen(false);
          }}
          className="flex-1 min-h-0 overflow-y-auto pixel-scrollbar px-8 py-6 flex flex-col gap-8"
          aria-label="Conversation"
        >
          {showTopControl && <div className="flex justify-center shrink-0">{topControl}</div>}
          {thread.length === 0 ? (
            <span className="text-xs text-text-muted">{emptyText}</span>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col gap-8">
              {thread.map((item: ThreadItem) =>
                item.kind === 'tools' ? (
                  <ToolGroup key={item.key} entries={item.entries} now={now} />
                ) : (
                  <ChatMessage
                    key={item.key}
                    entry={item.entry}
                    agentName={agentName}
                    now={now}
                    isInOffice={isInOffice}
                    onJump={onJump}
                  />
                ),
              )}
            </ul>
          )}
        </div>
        {unseen && (
          <Button
            size="sm"
            className="absolute bottom-6 left-1/2 -translate-x-1/2 shadow-pixel"
            onClick={jumpToNewest}
          >
            Newest ↓
          </Button>
        )}
      </div>
      {canAct && <div className="shrink-0 px-8 pt-4 pb-8 border-t-2 border-border">{replyBox}</div>}
    </div>
  );
}
