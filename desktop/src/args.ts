/**
 * The desktop app's own switches. Everything else on the command line
 * (Chromium switches, the app path) is ignored.
 *
 *   --smoke              start, render the office, capture the window, quit
 *   --smoke-out=<path>   where the capture goes (default: smoke.png in the cwd)
 *   --smoke-reconnect    also click the sign-in card's Reconnect button when
 *                        the card shows (no Conductor sign-in, so no Conductor
 *                        request either), and wait for the app's answer
 *   --demo               show the scripted demo (synthetic sessions) instead of
 *                        connecting to Conductor, as `poke-agents --demo` does
 *
 * POKE_AGENTS_SMOKE=1, POKE_AGENTS_SMOKE_OUT, POKE_AGENTS_SMOKE_RECONNECT=1 and
 * POKE_AGENTS_DEMO=1 do the same from the environment.
 */

export interface DesktopArgs {
  smoke: boolean;
  smokeOut?: string;
  smokeReconnect?: boolean;
  /** Present (true) only for a demo launch. */
  demo?: true;
}

const SMOKE_OUT_PREFIX = '--smoke-out=';

export function parseDesktopArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): DesktopArgs {
  let smoke = env.POKE_AGENTS_SMOKE === '1';
  let smokeOut = env.POKE_AGENTS_SMOKE_OUT || undefined;
  let smokeReconnect = env.POKE_AGENTS_SMOKE_RECONNECT === '1';
  let demo = env.POKE_AGENTS_DEMO === '1';
  for (const arg of argv) {
    if (arg === '--smoke') smoke = true;
    else if (arg === '--smoke-reconnect') smokeReconnect = true;
    else if (arg === '--demo') demo = true;
    else if (arg.startsWith(SMOKE_OUT_PREFIX) && arg.length > SMOKE_OUT_PREFIX.length) {
      smoke = true;
      smokeOut = arg.slice(SMOKE_OUT_PREFIX.length);
    }
  }
  const mode: Pick<DesktopArgs, 'demo'> = demo ? { demo: true } : {};
  if (!smoke) return { smoke, ...mode };
  return smokeReconnect
    ? { smoke, smokeOut, smokeReconnect, ...mode }
    : { smoke, smokeOut, ...mode };
}
