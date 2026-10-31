import { useEffect, useRef } from 'react';

import {
  MUSIC_MARQUEE_END_PAUSE_MS,
  MUSIC_MARQUEE_PX_PER_SEC,
  MUSIC_MARQUEE_STEPS_PER_SEC,
} from './constants.js';

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * One line of text that scrolls back and forth in pixel steps when it is
 * wider than its box (the now-playing line), with a pause at each end.
 * Reduced motion: the line is cut with an ellipsis instead.
 */
export function Marquee({ text, className = '' }: { text: string; className?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const reduced = prefersReducedMotion();

  useEffect(() => {
    const box = outer.current;
    const line = inner.current;
    if (reduced || !box || !line || typeof line.animate !== 'function') return;
    let animation: Animation | null = null;
    const start = () => {
      animation?.cancel();
      animation = null;
      const overflow = line.scrollWidth - box.clientWidth;
      if (overflow <= 0) return;
      const moveMs = (overflow / MUSIC_MARQUEE_PX_PER_SEC) * 1000;
      const total = moveMs + 2 * MUSIC_MARQUEE_END_PAUSE_MS;
      const hold = MUSIC_MARQUEE_END_PAUSE_MS / total;
      const steps = Math.max(1, Math.round((total / 1000) * MUSIC_MARQUEE_STEPS_PER_SEC));
      animation = line.animate(
        [
          { transform: 'translateX(0)', offset: 0 },
          { transform: 'translateX(0)', offset: hold },
          { transform: `translateX(${-overflow}px)`, offset: 1 - hold },
          { transform: `translateX(${-overflow}px)`, offset: 1 },
        ],
        {
          duration: total,
          iterations: Infinity,
          direction: 'alternate',
          easing: `steps(${steps})`,
        },
      );
    };
    start();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(start);
    observer?.observe(box);
    return () => {
      observer?.disconnect();
      animation?.cancel();
    };
  }, [text, reduced]);

  if (reduced) {
    return (
      <div className={`truncate ${className}`} title={text}>
        {text}
      </div>
    );
  }
  return (
    <div ref={outer} className={`overflow-hidden whitespace-nowrap ${className}`} title={text}>
      <span ref={inner} className="inline-block">
        {text}
      </span>
    </div>
  );
}
