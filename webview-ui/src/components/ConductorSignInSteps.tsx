import { signInSteps } from '../conductor/format.js';
import { isDesktopApp } from '../desktopApp.js';

/** The numbered Conductor sign-in steps, worded for the browser or the desktop app. */
export function ConductorSignInSteps({ className }: { className: string }) {
  return (
    <ol className={className}>
      {signInSteps(isDesktopApp).map((step) => (
        <li key={step.lead + (step.accent ?? '')}>
          {step.lead}
          {step.accent && <span className="text-accent">{step.accent}</span>}
          {step.tail}
        </li>
      ))}
    </ol>
  );
}
