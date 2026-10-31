import { type CSSProperties, useEffect, useRef, useState } from 'react';

import { CONDUCTOR_CONNECT_ANSWER_TIMEOUT_MS } from '../../../core/src/constants.js';
import { connectConductor } from '../conductor/actions.js';
import { connectAnswer, useConductor } from '../conductor/conductorStore.js';
import {
  apiKeyFromText,
  CONDUCTOR_CLI_LOGIN_COMMAND,
  envKeyRejected,
  envKeyRejectedText,
  keyStorageNote,
  maskedKeyHint,
  pasteBlockedMessage,
  safeHttpsUrl,
} from '../conductor/format.js';
import { COPY_FEEDBACK_MS } from '../constants.js';
import { desktopBridge } from '../desktopApp.js';
import { writeClipboardText } from '../terminal/clipboard.js';
import { Button } from './ui/Button.js';

const KEY_SHAPE_ERROR = "That doesn't look like a Conductor API key.";
const NO_ANSWER_ERROR = 'No answer from the office. Try again.';
const NOTHING_TO_PASTE = 'Nothing to paste.';
const NO_KEY_ON_CLIPBOARD = 'No API key on the clipboard.';

/**
 * The key field is a text input masked with CSS where the browser can, not a
 * password field: Chrome ignores autocomplete="off" on password fields and
 * may offer to save the key in its (possibly synced) password manager once
 * the card disappears after a connect. Elsewhere it falls back to a password
 * field. There is no <form> either, so nothing is "submitted" for a browser
 * to remember; Enter is handled on the field.
 */
const MASK_WITH_CSS =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('-webkit-text-security', 'disc');
const MASK_STYLE = { WebkitTextSecurity: 'disc' } as CSSProperties;

/** The browser can read the clipboard only in a secure context. A tokened LAN
 *  http:// office has no Clipboard API, and the prompt() fallback the
 *  terminal uses would show the key in clear text: no Paste there. */
function browserCanPaste(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof navigator.clipboard?.readText === 'function'
  );
}

/** The browser clipboard on the Paste click: its text, or what to say. */
async function readBrowserClipboard(): Promise<{ text: string } | { error: string }> {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    return text ? { text } : { error: NOTHING_TO_PASTE };
  } catch {
    // Denied permission or a dismissed paste callout.
    return { error: pasteBlockedMessage(navigator.platform || navigator.userAgent) };
  }
}

/** A command shown in the CLI disclosure; clicking it copies it. */
function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <button
        type="button"
        title="Copy"
        className="p-0 bg-transparent border-0 text-accent cursor-pointer underline decoration-dotted underline-offset-4 hover:text-accent-bright text-left break-all"
        onClick={() => {
          void writeClipboardText(command).then((ok) => setCopied(ok));
        }}
      >
        {command}
      </button>
      {copied && <span className="text-text-muted"> Copied</span>}
    </>
  );
}

/** The desktop app's Reconnect button (after a CLI login); nothing in a browser. */
function ReconnectButton() {
  if (!desktopBridge) return null;
  return (
    <Button size="sm" variant="default" onClick={() => desktopBridge?.reconnectConductor()}>
      Reconnect
    </Button>
  );
}

/**
 * Connect to Conductor: get an API key from Conductor's API keys page, paste
 * it, Connect. The office checks it with Conductor and keeps it in Poke
 * Agents' own store (the macOS Keychain, or until Poke Agents quits), never in
 * Conductor's own sign-in. The key lives in this component's state until it
 * is sent, and the field is cleared once Conductor accepts it.
 *
 * In the Mac app, after "Get an API key" sends the user to the browser, the
 * first time the window regains focus it asks the app once for a key on the
 * clipboard (main answers only when that link was just opened, and only text
 * shaped like a Conductor key) and offers it, masked, to fill the field. The
 * clipboard is read then and on the Paste click, never otherwise, and nothing
 * is sent until the user clicks Connect.
 */
export function ConductorConnectCard({ readOnly }: { readOnly: boolean }) {
  const status = useConductor((s) => s.status);
  const outcome = useConductor((s) => s.signIn);
  const [draft, setDraft] = useState('');
  /** The sign-in outcome seq when a connect was sent; null when none is pending. */
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectedAs, setConnectedAs] = useState<string | null>(null);
  /** A key the Mac app found on the clipboard, offered to fill the field. */
  const [suggestion, setSuggestion] = useState<string | null>(null);
  /** Bumped by each "Get an API key" click in the Mac app: the next focus
   *  looks at the clipboard once. */
  const [clipboardLook, setClipboardLook] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const answer = pendingSince === null ? null : connectAnswer(outcome, pendingSince);
  useEffect(() => {
    if (!answer) return;
    setPendingSince(null);
    if (answer.ok) {
      setDraft('');
      setSuggestion(null);
      setError(null);
      setConnectedAs(answer.message ?? 'Connected to Conductor');
    } else {
      setError(answer.message ?? "Couldn't connect to Conductor.");
      inputRef.current?.focus();
    }
  }, [answer]);

  useEffect(() => {
    if (pendingSince === null) return;
    const timer = setTimeout(() => {
      setPendingSince(null);
      setError(NO_ANSWER_ERROR);
    }, CONDUCTOR_CONNECT_ANSWER_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pendingSince]);

  useEffect(() => {
    const bridge = desktopBridge;
    if (clipboardLook === 0 || typeof bridge?.clipboardKeySuggestion !== 'function') return;
    let live = true;
    // One look, on the first focus after the browser took it.
    const look = () => {
      void bridge.clipboardKeySuggestion?.().then((key) => {
        if (live && key) setSuggestion(key);
      });
    };
    window.addEventListener('focus', look, { once: true });
    return () => {
      live = false;
      window.removeEventListener('focus', look);
    };
  }, [clipboardLook]);

  if (readOnly) {
    return (
      <span className="text-xs text-text-muted">
        View-only offices can&apos;t connect. Open the office&apos;s tokened URL.
      </span>
    );
  }

  if (envKeyRejected(status)) {
    return <span className="text-xs">{envKeyRejectedText(status)}</span>;
  }

  const pending = pendingSince !== null;
  const keyPageUrl = safeHttpsUrl(status?.keyPageUrl);
  const canPaste = desktopBridge !== undefined || browserCanPaste();

  const submit = (text: string) => {
    if (pending) return;
    const key = apiKeyFromText(text);
    if (!key) {
      setError(KEY_SHAPE_ERROR);
      inputRef.current?.focus();
      return;
    }
    setError(null);
    setConnectedAs(null);
    setSuggestion(null);
    setPendingSince(outcome?.seq ?? -1);
    connectConductor(key);
  };

  const fill = (text: string) => {
    setDraft(text);
    setSuggestion(null);
    setError(null);
    inputRef.current?.focus();
  };

  const paste = async () => {
    if (desktopBridge) {
      const key = await desktopBridge.readClipboardKey();
      if (key) fill(key);
      else setError(NO_KEY_ON_CLIPBOARD);
      return;
    }
    const read = await readBrowserClipboard();
    if ('text' in read) fill(read.text);
    else setError(read.error);
  };

  return (
    <div className="flex flex-col gap-8 text-left w-full" data-testid="conductor-connect">
      {status?.state === 'unauthorized' && (
        <span className="text-xs text-status-error">
          Conductor rejected the saved key. Connect with a new one.
        </span>
      )}
      <ol className="m-0 pl-24 flex flex-col gap-8 text-xs list-decimal">
        <li>
          {keyPageUrl ? (
            <a
              href={keyPageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block border-2 rounded-none cursor-pointer bg-btn-bg border-border hover:bg-btn-hover text-text no-underline py-1 px-8 text-sm"
              onClick={() => {
                if (desktopBridge) setClipboardLook((n) => n + 1);
              }}
            >
              Get an API key
            </a>
          ) : (
            <span>Create an API key in Conductor.</span>
          )}
        </li>
        <li>
          {/* A wrapper: display:flex on the <li> itself would drop its "2." */}
          <div className="flex flex-col gap-6">
            <label htmlFor="conductor-api-key">Paste it here and connect:</label>
            {suggestion && !pending && (
              <div className="flex items-center gap-6">
                <Button type="button" size="sm" variant="active" onClick={() => fill(suggestion)}>
                  Use key from clipboard
                </Button>
                <span className="text-2xs text-text-muted" data-testid="conductor-clipboard-hint">
                  {maskedKeyHint(suggestion)}
                </span>
              </div>
            )}
            <div className="flex items-center gap-4">
              <input
                ref={inputRef}
                id="conductor-api-key"
                type={MASK_WITH_CSS ? 'text' : 'password'}
                style={MASK_WITH_CSS ? MASK_STYLE : undefined}
                value={draft}
                disabled={pending}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                data-form-type="other"
                placeholder="API key"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'conductor-api-key-error' : undefined}
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  submit(draft);
                }}
                className="flex-1 min-w-0 text-xs py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
              />
              {canPaste && (
                <Button
                  type="button"
                  size="sm"
                  disabled={pending}
                  className="shrink-0"
                  onClick={() => void paste()}
                >
                  Paste
                </Button>
              )}
            </div>
            <div className="flex items-center gap-8">
              <Button
                type="button"
                size="md"
                variant={pending ? 'disabled' : 'accent'}
                disabled={pending}
                onClick={() => submit(draft)}
              >
                {pending ? 'Connecting…' : 'Connect'}
              </Button>
              {error && (
                <span
                  id="conductor-api-key-error"
                  role="alert"
                  className="text-xs text-status-error"
                >
                  {error}
                </span>
              )}
              {!error && connectedAs && (
                <span role="status" className="text-xs text-status-success whitespace-pre-line">
                  {connectedAs}
                </span>
              )}
            </div>
          </div>
        </li>
      </ol>
      <span className="text-2xs leading-tight text-text-muted">
        {keyStorageNote(status?.keyStorage)}
      </span>
      {/* The CLI path is a Mac one: a server on macOS, or the Mac app (whose
          Reconnect also serves its Linux smoke run). */}
      {(status?.keyStorage === 'keychain' || desktopBridge !== undefined) && (
        <details className="text-2xs leading-tight text-text-muted">
          <summary className="cursor-pointer">Prefer the CLI?</summary>
          <div className="flex flex-col gap-4 pt-4">
            <span>
              Run <CopyableCommand command={CONDUCTOR_CLI_LOGIN_COMMAND} /> in Terminal
              {desktopBridge ? ', then reconnect.' : ', then restart Poke Agents.'}
            </span>
            <div>
              <ReconnectButton />
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
