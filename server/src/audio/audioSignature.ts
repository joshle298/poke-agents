/**
 * What kind of audio a file's first bytes announce. Shared by the cry cache
 * (which keeps only Ogg or MP3: the PokéAPI cries are Ogg, but a few, like
 * Pikachu's `latest`, are MP3 under the same `.ogg` name) and the sound pack
 * (whose bytes must match the file's extension).
 */

export type AudioFormat = 'ogg' | 'mp3' | 'wav';

/** Bytes to read before calling sniffAudioFormat. */
export const AUDIO_SIGNATURE_BYTES = 12;

export function sniffAudioFormat(head: Buffer): AudioFormat | null {
  if (head.length >= 4 && head.toString('latin1', 0, 4) === 'OggS') return 'ogg';
  // An ID3v2 tag, or an MPEG audio frame sync (11 set bits).
  if (head.length >= 3 && head.toString('latin1', 0, 3) === 'ID3') return 'mp3';
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3';
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
