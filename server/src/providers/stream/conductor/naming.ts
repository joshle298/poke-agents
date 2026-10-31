/**
 * Display names for Conductor sessions (CN §12): the nickname, the repo slug
 * and the short repo name used as the Area-mapping key.
 */

import type { ConductorSession, ConductorWorkspace } from './types.js';

/** `https://github.com/owner/repo(.git)` → `owner/repo`; other hosts → host + path. */
export function repoSlug(repoUrl: string | undefined): string | undefined {
  if (!repoUrl) return undefined;
  const github =
    /^(?:https?:\/\/|git@|ssh:\/\/git@)?(?:www\.)?github\.com[/:]([^/]+\/[^/#?]+?)(?:\.git)?\/?$/i.exec(
      repoUrl.trim(),
    );
  if (github) return github[1];
  try {
    const url = new URL(repoUrl);
    const slug = `${url.host}${url.pathname}`.replace(/\.git$/, '').replace(/\/+$/, '');
    return slug || undefined;
  } catch {
    return repoUrl.replace(/\.git$/, '') || undefined;
  }
}

/** Last path segment of the repo slug (`example-repo`). */
export function repoShortName(repoUrl: string | undefined): string | undefined {
  const slug = repoSlug(repoUrl);
  if (!slug) return undefined;
  const parts = slug.split('/').filter(Boolean);
  return parts[parts.length - 1];
}

/** Session name, else `#<number> <workspace name>`. */
export function sessionLabel(
  session: Pick<ConductorSession, 'name'>,
  workspace: Pick<ConductorWorkspace, 'name' | 'number'> | undefined,
): string {
  const name = session.name?.trim();
  if (name) return name;
  if (workspace) {
    const number = typeof workspace.number === 'number' ? `#${workspace.number}` : '';
    const label = [number, workspace.name?.trim()].filter(Boolean).join(' ');
    if (label) return label;
  }
  return 'Conductor session';
}
