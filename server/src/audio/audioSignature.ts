/**
 * What kind of audio a file's first bytes announce. Shared by the cry cache
 * (which keeps only Ogg or MP3: the PokéAPI cries are Ogg, but a few, like
 * Pikachu's `latest`, are MP3 under the same `.ogg` name) and the sound pack
 * (whose bytes must match the file's extension).
 */

export type AudioFormat = 'ogg' | 'mp3' | 'wav';

/** Bytes to read before calling sniffAudioFormat. */
export const AUDIO_SIGNATURE_BYTES = 12;

/**
 * An MP3 frame header without an ID3 tag (as Pikachu's cry starts): the
 * 11-bit frame sync, a defined MPEG version, Layer III, and a bitrate and
 * sample rate that aren't reserved. Text that happens to start with FF Ex,
 * like a UTF-16LE byte-order mark (FF FE), fails.
 */
function isMp3Frame(head: Buffer): boolean {
  if (head.length < 3 || head[0] !== 0xff || (head[1] & 0xe0) !== 0xe0) return false;
  const version = (head[1] >> 3) & 0b11; // 01 is reserved
  const layer = (head[1] >> 1) & 0b11; // 01 is Layer III
  const bitrate = head[2] >> 4; // 0000 is "free", 1111 is invalid
  const sampleRate = (head[2] >> 2) & 0b11; // 11 is reserved
  return (
    version !== 0b01 && layer === 0b01 && bitrate !== 0 && bitrate !== 0b1111 && sampleRate !== 0b11
  );
}

export function sniffAudioFormat(head: Buffer): AudioFormat | null {
  if (head.length >= 4 && head.toString('latin1', 0, 4) === 'OggS') return 'ogg';
  if (head.length >= 3 && head.toString('latin1', 0, 3) === 'ID3') return 'mp3';
  if (isMp3Frame(head)) return 'mp3';
  if (
    head.length >= 12 &&
    head.toString('latin1', 0, 4) === 'RIFF' &&
    head.toString('latin1', 8, 12) === 'WAVE'
  ) {
    return 'wav';
  }
  return null;
}

export const AUDIO_CONTENT_TYPES: Readonly<Record<AudioFormat, string>> = {
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};
