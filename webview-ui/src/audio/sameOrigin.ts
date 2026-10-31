/**
 * Sound URLs come from the local server (the species payload's `cry`, the
 * sound pack list). Only same-origin http(s) URLs are ever fetched, like the
 * sprite sheets (pokemonSprites.isAllowedSpriteUrl).
 */
export function isSameOriginUrl(url: string, origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(url, origin);
    return (
      parsed.origin === origin && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    );
  } catch {
    return false;
  }
}

/** The page's origin, or undefined outside a browser (Node tests). */
export function pageOrigin(): string | undefined {
  return (globalThis as { location?: { origin?: string } }).location?.origin;
}
