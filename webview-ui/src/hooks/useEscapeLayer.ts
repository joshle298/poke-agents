import { useEffect, useRef } from 'react';

import type { EscapeLayerOptions } from '../escapeStack.js';
import { EscapeStack } from '../escapeStack.js';

/** The app's one Escape stack (see escapeStack.ts). */
export const escapeStack = new EscapeStack();

const FIELD_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

let listening = false;

/** One capture-phase listener on window: it runs before every bubble-phase
 *  handler (the layout editor, React's own), so a closed layer's Escape stops
 *  here. */
function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener(
    'keydown',
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const taken = escapeStack.handle({
        key: e.key,
        isComposing: e.isComposing,
        inField: target !== null && target.closest(FIELD_SELECTOR) !== null,
      });
      if (taken) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
}

/**
 * While `active`, Escape calls `onEscape` when this surface is the topmost
 * open one. The callback may change identity on every render; the layer
 * keeps its place in the stack.
 */
export function useEscapeLayer(
  active: boolean,
  onEscape: () => void,
  { z, closeFromFields = true }: EscapeLayerOptions,
): void {
  const latest = useRef(onEscape);
  useEffect(() => {
    latest.current = onEscape;
  });
  useEffect(() => {
    if (!active) return;
    listen();
    return escapeStack.push(() => latest.current(), { z, closeFromFields });
  }, [active, z, closeFromFields]);
}
