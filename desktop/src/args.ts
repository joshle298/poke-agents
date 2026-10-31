/**
 * The desktop app's own switches. Everything else on the command line
 * (Chromium switches, the app path) is ignored.
 *
 *   --smoke              start, render the office, capture the window, quit
 *   --smoke-out=<path>   where the capture goes (default: smoke.png in the cwd)
 *
 * POKE_AGENTS_SMOKE=1 and POKE_AGENTS_SMOKE_OUT do the same from the environment.
 */

export interface DesktopArgs {
  smoke: boolean;
  smokeOut?: string;
}

const SMOKE_OUT_PREFIX = '--smoke-out=';

export function parseDesktopArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): DesktopArgs {
  let smoke = env.POKE_AGENTS_SMOKE === '1';
  let smokeOut = env.POKE_AGENTS_SMOKE_OUT || undefined;
  for (const arg of argv) {
    if (arg === '--smoke') smoke = true;
    else if (arg.startsWith(SMOKE_OUT_PREFIX) && arg.length > SMOKE_OUT_PREFIX.length) {
      smoke = true;
      smokeOut = arg.slice(SMOKE_OUT_PREFIX.length);
    }
  }
  return smoke ? { smoke, smokeOut } : { smoke };
}
