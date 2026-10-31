/**
 * HTTP Range parsing for the music route (RFC 9110 §14.2): one byte range per
 * request, which is all an <audio> element asks for when it seeks.
 */

/** Inclusive byte offsets. */
export interface ByteRange {
  start: number;
  end: number;
}

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * The range to serve for a `Range` header against a file of `size` bytes:
 * - `null`: serve the whole file (no header, another unit, several ranges, or
 *   a malformed value, which the RFC says to ignore);
 * - `'unsatisfiable'`: answer 416;
 * - otherwise the clamped range, for a 206.
 */
export function parseRangeHeader(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (header === undefined) return null;
  const match = SINGLE_RANGE.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  if (rawStart === '') {
    // Suffix range: the last N bytes.
    const length = Number(rawEnd);
    if (!Number.isSafeInteger(length)) return null;
    if (length === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === '' ? Number.MAX_SAFE_INTEGER : Number(rawEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (end < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}
