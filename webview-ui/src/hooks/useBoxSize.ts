import { useCallback, useState } from 'react';

export interface BoxSize {
  width: number;
  height: number;
}

const EMPTY: BoxSize = { width: 0, height: 0 };

/**
 * An element's border-box size, kept current by a ResizeObserver. Returns a
 * callback ref for the element and its size (0 × 0 while nothing is
 * attached). The first measurement is taken while the ref attaches, so
 * layout that depends on it is right on the first paint.
 */
export function useBoxSize<T extends HTMLElement>(): [(element: T | null) => () => void, BoxSize] {
  const [size, setSize] = useState<BoxSize>(EMPTY);
  const ref = useCallback((element: T | null) => {
    if (!element) return () => {};
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      setSize(EMPTY);
    };
  }, []);
  return [ref, size];
}
