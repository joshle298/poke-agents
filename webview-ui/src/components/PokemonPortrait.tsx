import type { ReactNode } from 'react';
import { useState } from 'react';

import { ORB_CLOSED_SPRITE } from '../office/sprites/pokemonUiSprites.js';

interface PokemonPortraitProps {
  /** Portrait URL from pokemonSpeciesLoaded (same-origin, served by the
   *  local server's cache). Absent until the species loads. */
  url?: string;
  /** On-screen side in CSS px (an integer multiple of the 40-px source). */
  size: number;
  /** Drawn instead when there is no URL or the image fails to load. */
  fallback: ReactNode;
  alt?: string;
  /** 'lazy' for long grids (Change Pokémon): fetched only near the viewport. */
  loading?: 'eager' | 'lazy';
}

/**
 * A PMD portrait, scaled with nearest-neighbour so it stays crisp. Falls back
 * (to the orb in a Pokémon office, else the upstream mug shot) whenever
 * the image is missing, so a slot never shows a broken image.
 */
export function PokemonPortrait({
  url,
  size,
  fallback,
  alt = '',
  loading = 'eager',
}: PokemonPortraitProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!url || failedUrl === url) return <>{fallback}</>;
  return (
    <img
      src={url}
      alt={alt}
      width={size}
      height={size}
      loading={loading}
      draggable={false}
      onError={() => setFailedUrl(url)}
      className="shrink-0 select-none"
      style={{ width: size, height: size, imageRendering: 'pixelated' }}
    />
  );
}

/** The orb as runs of same-colour pixels, one rect each: [x, y, width, colour]. */
const ORB_RUNS: Array<[number, number, number, string]> = ORB_CLOSED_SPRITE.flatMap((row, y) => {
  const runs: Array<[number, number, number, string]> = [];
  row.forEach((color, x) => {
    if (!color) return;
    const last = runs.at(-1);
    if (last && last[3] === color && last[0] + last[2] === x) last[2]++;
    else runs.push([x, y, 1, color]);
  });
  return runs;
});
const ORB_W = ORB_CLOSED_SPRITE[0].length;
const ORB_H = ORB_CLOSED_SPRITE.length;

/** The office's closed orb (sprites/orb.json) as pixel art, centred in a
 *  `size` square at a whole number of CSS px per pixel and a whole CSS px
 *  offset, for sessions with no Pokémon to show. (The component keeps the
 *  name it had when the office threw capsules.) */
export function CapsuleIcon({ size }: { size: number }) {
  const scale = Math.max(1, Math.floor(size / ORB_W));
  const side = size / scale;
  const left = Math.round(((ORB_W - side) / 2) * scale) / scale;
  const top = Math.round(((ORB_H - side) / 2) * scale) / scale;
  return (
    <svg
      aria-hidden="true"
      className="inline-block shrink-0"
      width={size}
      height={size}
      viewBox={`${left} ${top} ${side} ${side}`}
      shapeRendering="crispEdges"
    >
      {ORB_RUNS.map(([x, y, width, color]) => (
        <rect key={`${x},${y}`} x={x} y={y} width={width} height={1} fill={color} />
      ))}
    </svg>
  );
}
