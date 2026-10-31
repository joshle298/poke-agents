import { useEffect, useState } from 'react';

import { signInSteps } from '../conductor/format.js';
import { COPY_FEEDBACK_MS } from '../constants.js';
import { desktopBridge, isDesktopApp } from '../desktopApp.js';
import { writeClipboardText } from '../terminal/clipboard.js';
import { Button } from './ui/Button.js';

/** A command shown in a step; clicking it copies it. */
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
        className="p-0 bg-transparent border-0 text-accent cursor-pointer underline decoration-dotted underline-offset-4 hover:text-accent-bright"
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

/** The numbered Conductor sign-in steps, worded for the browser or the desktop app. */
export function ConductorSignInSteps({ className }: { className: string }) {
  return (
    <ol className={`list-decimal ${className}`}>
      {signInSteps(isDesktopApp, desktopBridge !== undefined).map((step) => (
        <li key={step.lead + (step.accent ?? '')}>
          {step.lead}
          {step.accent &&
            (step.copy ? (
              <CopyableCommand command={step.accent} />
            ) : (
              <span className="text-accent">{step.accent}</span>
            ))}
          {step.tail}
        </li>
      ))}
    </ol>
  );
}

/** The desktop app's Reconnect button (after `conductor auth login`); nothing
 *  in a browser. */
export function ConductorReconnectButton() {
  if (!desktopBridge) return null;
  return (
    <Button size="md" variant="accent" onClick={() => desktopBridge?.reconnectConductor()}>
      Reconnect
    </Button>
  );
}
