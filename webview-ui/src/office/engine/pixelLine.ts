/**
 * Bresenham walk over whole world pixels, for lines drawn as pixel art
 * (links on the floor, the recall beam). Pure: the caller decides what to
 * paint at each step.
 */
export function forEachLinePixel(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  visit: (x: number, y: number, step: number) => void,
): void {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const xEnd = Math.round(x1);
  const yEnd = Math.round(y1);
  const dx = Math.abs(xEnd - x);
  const dy = -Math.abs(yEnd - y);
  const sx = x < xEnd ? 1 : -1;
  const sy = y < yEnd ? 1 : -1;
  let err = dx + dy;
  for (let step = 0; ; step++) {
    visit(x, y, step);
    if (x === xEnd && y === yEnd) return;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/** Whether pixel `step` of a dashed line is lit, with the pattern marching
 *  forward (from the line's start toward its end) by `march` pixels. */
export function isDashLit(step: number, march: number, period: number, on: number): boolean {
  const phase = (((step - Math.floor(march)) % period) + period) % period;
  return phase < on;
}
