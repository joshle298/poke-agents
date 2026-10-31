import type { ReactNode } from 'react';
import { useState } from 'react';

interface PokemonPortraitProps {
  /** Portrait URL from pokemonSpeciesLoaded (same-origin, served by the
   *  local server's cache). Absent until the species loads. */
  url?: string;
  /** On-screen side in CSS px (an integer multiple of the 40-px source). */
  size: number;
  /** Drawn instead when there is no URL or the image fails to load. */
  fallback: ReactNode;
  alt?: string;
}

/**
 * A PMD portrait, scaled with nearest-neighbour so it stays crisp. Falls back
 * (to the upstream mug shot, or a Poké Ball) whenever the image is missing,
 * so a slot never shows a broken image.
 */
export function PokemonPortrait({ url, size, fallback, alt = '' }: PokemonPortraitProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!url || failedUrl === url) return <>{fallback}</>;
  return (
    <img
      src={url}
      alt={alt}
      width={size}
      height={size}
      draggable={false}
      onError={() => setFailedUrl(url)}
      className="shrink-0 select-none"
      style={{ width: size, height: size, imageRendering: 'pixelated' }}
    />
  );
}

/** The in-house pixel Poké Ball (styled in index.css), for sessions with no
 *  Pokémon to show. */
export function PokeBallIcon({ size }: { size: number }) {
  return (
    <span
      aria-hidden="true"
      className="pokeball-icon inline-block shrink-0"
      style={{ width: size, height: size }}
    />
  );
}
