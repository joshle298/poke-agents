import type { SendState } from '../conductor/chat.js';
import { isSendKey } from '../conductor/chat.js';
import { Button } from './ui/Button.js';

interface ReplyBoxProps {
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: () => void;
  state: SendState;
  /** Conductor's refusal, for the failed state. */
  errorMessage?: string;
  rows?: number;
  /** Enter sends (keyboards). False on phones: Enter is a new line there and
   *  the Send button sends. Default true. */
  enterSends?: boolean;
}

const STATUS_TEXT: Record<Exclude<SendState, 'failed' | 'idle'>, string> = {
  sending: 'Sending…',
  sent: 'Sent.',
  unconfirmed: 'No answer yet. Check the session before sending again.',
};

/**
 * The Pokédex reply box: a plain message to the session (sendSessionMessage).
 * Enter sends, Shift+Enter adds a line, and the Enter that confirms an IME
 * composition only confirms it (phones: Enter adds a line, Send sends). One
 * send at a time.
 */
export function ReplyBox({
  draft,
  onDraftChange,
  onSend,
  state,
  errorMessage,
  rows = 2,
  enterSends = true,
}: ReplyBoxProps) {
  const sending = state === 'sending';
  const canSend = draft.trim().length > 0 && !sending;
  const status =
    state === 'failed'
      ? `Couldn't send: ${errorMessage ?? 'Conductor refused the message.'}`
      : state === 'idle'
        ? enterSends
          ? 'Enter to send, Shift+Enter for a new line'
          : ''
        : STATUS_TEXT[state];
  return (
    <div className="flex flex-col gap-4">
      <textarea
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={(e) => {
          const key = {
            key: e.key,
            shiftKey: e.shiftKey,
            isComposing: e.nativeEvent.isComposing,
            keyCode: e.keyCode,
          };
          if (!enterSends || !isSendKey(key)) return;
          e.preventDefault();
          if (canSend) onSend();
        }}
        rows={rows}
        placeholder="Message this session…"
        aria-label="Message this session"
        className="w-full resize-none text-xs py-4 px-6 bg-btn-bg border-2 border-border rounded-none text-text"
      />
      <div className="flex items-center justify-between gap-6">
        <span
          className={`text-2xs leading-tight min-w-0 ${
            state === 'failed' ? 'text-status-error' : 'text-text-muted'
          }`}
          aria-live="polite"
        >
          {status}
        </span>
        <Button
          size="sm"
          className="shrink-0"
          variant={canSend ? 'default' : 'disabled'}
          disabled={!canSend}
          onClick={onSend}
        >
          {sending ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </div>
  );
}
