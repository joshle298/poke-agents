import { type FormEvent, useEffect, useRef, useState } from 'react';

import { connectConductor } from '../conductor/actions.js';
import { connectAnswer, useConductor } from '../conductor/conductorStore.js';
import {
  apiKeyFromText,
  CONDUCTOR_CLI_LOGIN_COMMAND,
  envKeyRejected,
  keyStorageNote,
  safeHttpsUrl,
} from '../conductor/format.js';
import { CONDUCTOR_CONNECT_TIMEOUT_MS, COPY_FEEDBACK_MS } from '../constants.js';
import { desktopBridge } from '../desktopApp.js';
import { readClipboardText, writeClipboardText } from '../terminal/clipboard.js';
import { Button } from './ui/Button.js';

const KEY_SHAPE_ERROR = "That doesn't look like a Conductor API key.";
const NO_ANSWER_ERROR = 'No answer from the office. Try again.';

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
 * Agents' own store (the macOS Keychain, or this session only), never in
 * Conductor's own sign-in. The key lives in this component's state until it
 * is sent, and the field is cleared once Conductor accepts it.
 *
 * In the Mac app, after "Get an API key" sends the user to the browser, the
 * window regaining focus asks the app for a key on the clipboard (the app
 * answers only key-shaped text) and offers it with one click. The clipboard
 * is read on those two occasions and the Paste click, never otherwise.
 */
export function ConductorConnectCard({ readOnly }: { readOnly: boolean }) {
  const status = useConductor((s) => s.status);
  const outcome = useConductor((s) => s.signIn);
  const [draft, setDraft] = useState('');
  /** The sign-in outcome seq when a connect was sent; null when none is pending. */
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectedAs, setConnectedAs] = useState<string | null>(null);
  /** A key the Mac app found on the clipboard, offered with one click. */
  const [suggestion, setSuggestion] = useState<string | null>(null);
  /** "Get an API key" was clicked in the Mac app: look at the clipboard when
   *  the window comes back. */
  const [watchClipboard, setWatchClipboard] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const answer = pendingSince === null ? null : connectAnswer(outcome, pendingSince);
  useEffect(() => {
    if (!answer) return;
    setPendingSince(null);
    if (answer.ok) {
      setDraft('');
      setSuggestion(null);
      setWatchClipboard(false);
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
    }, CONDUCTOR_CONNECT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pendingSince]);

  useEffect(() => {
    const bridge = desktopBridge;
    if (!watchClipboard || !bridge) return;
    let live = true;
    const look = () => {
      void bridge.readClipboardKey().then((key) => {
        if (live && key) setSuggestion(key);
      });
    };
    window.addEventListener('focus', look);
    return () => {
      live = false;
      window.removeEventListener('focus', look);
    };
  }, [watchClipboard]);

  if (readOnly) {
    return (
      <span className="text-xs text-text-muted">
        View-only offices can&apos;t connect. Open the office&apos;s tokened URL.
      </span>
    );
  }

  if (envKeyRejected(status)) {
    return (
      <span className="text-xs">
        Conductor rejected the key in <span className="text-accent">CONDUCTOR_API_KEY</span>. Update
        it, then restart Poke Agents.
      </span>
    );
  }

  const pending = pendingSince !== null;
  const keyPageUrl = safeHttpsUrl(status?.keyPageUrl);

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
    setPendingSince(outcome?.seq ?? -1);
    connectConductor(key);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit(draft);
  };

  const paste = async () => {
    const text = desktopBridge
      ? await desktopBridge.readClipboardKey()
      : await readClipboardText('Paste your Conductor API key');
    if (!text?.trim()) {
      setError(desktopBridge ? 'No API key on the clipboard.' : 'Nothing to paste.');
      return;
    }
    setDraft(text.trim());
    setError(null);
    inputRef.current?.focus();
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
                if (desktopBridge) setWatchClipboard(true);
              }}
            >
              Get an API key
            </a>
          ) : (
            <span>Create an API key in Conductor.</span>
          )}
        </li>
        <li>
          <form className="flex flex-col gap-6" onSubmit={onSubmit} autoComplete="off">
            <label htmlFor="conductor-api-key">Paste it here and connect:</label>
            {suggestion && !pending && (
              <Button
                type="button"
                size="sm"
                variant="active"
                className="self-start"
                onClick={() => {
                  setDraft(suggestion);
                  submit(suggestion);
                }}
              >
                Use key from clipboard
              </Button>
            )}
            <div className="flex items-center gap-4">
              <input
                ref={inputRef}
                id="conductor-api-key"
                type="password"
                value={draft}
                disabled={pending}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                placeholder="API key"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'conductor-api-key-error' : undefined}
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (error) setError(null);
                }}
                className="flex-1 min-w-0 text-xs py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
              />
              <Button
                type="button"
                size="sm"
                disabled={pending}
                className="shrink-0"
                onClick={() => void paste()}
              >
                Paste
              </Button>
            </div>
            <div className="flex items-center gap-8">
              <Button
                type="submit"
                size="md"
                variant={pending ? 'disabled' : 'accent'}
                disabled={pending}
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
                <span role="status" className="text-xs text-status-success">
                  {connectedAs}
                </span>
              )}
            </div>
          </form>
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
