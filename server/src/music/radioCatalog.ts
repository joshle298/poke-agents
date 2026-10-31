/**
 * Poke Agents Radio's checksum manifest: for every track in
 * core/src/radioCredits.ts, the file its author published, pinned by size and
 * SHA-256, and its measured loudness.
 *
 * The radio cache (radioCache.ts) downloads a track from `url` only when it is
 * first played, and keeps it only when its bytes match `bytes` and `sha256`
 * exactly, so a changed or substituted file is never played. Nothing here is
 * audio: the files stay on their authors' pages and are never committed.
 *
 * `lufs` is each file's integrated loudness (ITU-R BS.1770-4, K-weighted and
 * gated), measured from the decoded file. The station turns louder tracks down
 * to RADIO_TARGET_LUFS so a shuffle doesn't jump in volume (radioGain).
 *
 * To add a track: publish its credit in radioCredits.ts (original work, CC0
 * or CC BY, read on its page), then add its file here with the size and
 * SHA-256 of a fresh download and its measured loudness. radioCatalog.test.ts
 * checks the two lists match and the README credits them.
 */

import { RADIO_CREDITS, type RadioCredit } from '../../../core/src/radioCredits.js';
import { RADIO_TARGET_LUFS } from './constants.js';

export interface RadioFile {
  /** The author's own file (https). */
  url: string;
  bytes: number;
  /** Lower-case hex SHA-256 of the whole file. */
  sha256: string;
  mimeType: 'audio/ogg' | 'audio/mpeg';
  /** Integrated loudness, LUFS. */
  lufs: number;
}

/** A radio track: its credit and its pinned file. */
export interface RadioTrack extends RadioCredit, RadioFile {
  /** Cache file name: the id plus `.ogg` or `.mp3`. */
  fileName: string;
  /** Volume factor (0..1] that brings it to RADIO_TARGET_LUFS. */
  gain: number;
}

const OGA = 'https://opengameart.org/sites/default/files';

export const RADIO_FILES: Readonly<Record<string, RadioFile>> = {
  'radio-welcome-to-the-item-shop': {
    url: `${OGA}/welcome_to_the_item_shop_1.ogg`,
    bytes: 3_169_385,
    sha256: 'a3b783d367a7d1299bc3c34d7d7e1e7a7e23c3e91a89cf63223c6a6af82efd03',
    mimeType: 'audio/ogg',
    lufs: -11.96,
  },
  'radio-my-street': {
    url: `${OGA}/my_street.ogg`,
    bytes: 3_868_872,
    sha256: '5560f25dc0075045c21359dfbc6757a5b921c8ca1e7684ceddcb1431b9fc2c55',
    mimeType: 'audio/ogg',
    lufs: -10.78,
  },
  'radio-exploring-town': {
    url: `${OGA}/Exploring%20Town_0.ogg`,
    bytes: 4_519_249,
    sha256: '89ff4cbe568533b09d304f2b904f4d2c54d0f5855ec3f196972ec75f5c896f13',
    mimeType: 'audio/ogg',
    lufs: -8.4,
  },
  'radio-village-2018': {
    url: `${OGA}/Komiku%20-%20Tale%20on%20the%20Late%20-%2005%20Village%2C%202018.mp3`,
    bytes: 2_831_285,
    sha256: 'f0250f304d6ab11fcc3658a6606d38d1425c586d124524b814597abf8d1954c9',
    mimeType: 'audio/mpeg',
    lufs: -18.87,
  },
  'radio-flowerbed-fields': {
    url: `${OGA}/flowerbed_fields.ogg`,
    bytes: 1_724_097,
    sha256: '99607b996cc43c1891afcbf7c2c8d8aad1009266cea358d4753e3c50b1332d36',
    mimeType: 'audio/ogg',
    lufs: -18.9,
  },
  'radio-chill-overworld': {
    url: `${OGA}/chilloverworld-atmanan_1.mp3`,
    bytes: 1_922_821,
    sha256: '8bc472032ce1da89ccc9494815ddedde55649bf44a2e7ff1db523ad9c601d45d',
    mimeType: 'audio/mpeg',
    lufs: -17.33,
  },
  'radio-the-road-we-use-to-travel': {
    url: `${OGA}/Komiku%20-%20Tale%20on%20the%20Late%20-%2003%20The%20road%20we%20use%20to%20travel%20when%20we%20were%20kids_0.mp3`,
    bytes: 5_737_146,
    sha256: '8f36eba681d034d65832e992d6a0a7b9dffd2fa4a4ca00fde2340a9c039350fd',
    mimeType: 'audio/mpeg',
    lufs: -16.77,
  },
  'radio-stocked-up-on-potions': {
    url: `${OGA}/potions_0.ogg`,
    bytes: 4_447_232,
    sha256: '67dd5bd1b8ef80bf0e1515324392d26ca8b4af81f73b3b65d80a8145c833cd0d',
    mimeType: 'audio/ogg',
    lufs: -13.11,
  },
  'radio-apple-cider': {
    url: `${OGA}/apple_cider.ogg`,
    bytes: 3_240_559,
    sha256: '29dfe7f2491fa2cabd159db70db868445be253e395db5f75b30b3113f798f4ca',
    mimeType: 'audio/ogg',
    lufs: -14.76,
  },
  'radio-remember-the-time-we-use-to-play': {
    url: `${OGA}/Komiku%20-%20Tale%20on%20the%20Late%20-%2002%20Remember%20the%20time%20we%20use%20to%20play.mp3`,
    bytes: 3_963_954,
    sha256: 'b17052810aecb435537bd0e64c8560197df125798b43b3cb1c2423309dae023a',
    mimeType: 'audio/mpeg',
    lufs: -16.53,
  },
  'radio-airship-serenity': {
    url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Airship%20Serenity.mp3',
    bytes: 7_684_323,
    sha256: 'da92d172ea2c1bff452e0ae077ca2eff1be00f1a4b68955269a4ee16f37e1a69',
    mimeType: 'audio/mpeg',
    lufs: -12.2,
  },
  'radio-rpg-battle-theme': {
    url: `${OGA}/RPGBattleTheme-Loopable_0.ogg`,
    bytes: 2_119_501,
    sha256: '00ee019c1bbdac37e5800ed1131c38dfe39d943fdd0b69de0f830b81c8e81926',
    mimeType: 'audio/ogg',
    lufs: -17.48,
  },
};

const EXTENSIONS: Readonly<Record<RadioFile['mimeType'], string>> = {
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
};

/** The volume factor that turns a track of `lufs` down to RADIO_TARGET_LUFS
 *  (never up: an <audio> element's volume stops at 1). Rounded to 3 places. */
export function radioGain(lufs: number): number {
  const gain = Math.min(1, 10 ** ((RADIO_TARGET_LUFS - lufs) / 20));
  return Math.round(gain * 1000) / 1000;
}

/** Credits joined with their files, in credits order. A credit without a file
 *  (or a file without a credit) is a bug radioCatalog.test.ts catches; such a
 *  track is left out here rather than served unpinned. */
export function buildRadioCatalog(
  credits: readonly RadioCredit[] = RADIO_CREDITS,
  files: Readonly<Record<string, RadioFile>> = RADIO_FILES,
): RadioTrack[] {
  const tracks: RadioTrack[] = [];
  for (const credit of credits) {
    const file = Object.prototype.hasOwnProperty.call(files, credit.id)
      ? files[credit.id]
      : undefined;
    if (!file) continue;
    tracks.push({
      ...credit,
      ...file,
      fileName: `${credit.id}${EXTENSIONS[file.mimeType]}`,
      gain: radioGain(file.lufs),
    });
  }
  return tracks;
}
