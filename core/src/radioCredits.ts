/**
 * Poke Agents Radio's credits: every track the built-in Jukebox station can
 * play, with its author, license and the page it comes from. The one list the
 * app's About & credits shows, the README's "Radio credits" mirrors (a test
 * holds them to it) and the server's checksum manifest (server/src/music/
 * radioCatalog.ts) must cover exactly.
 *
 * Every track is an original composition, released by its author under CC0
 * or CC BY on the page linked here, and downloaded from that page's own file
 * on the user's computer the first time it plays. No audio is in the
 * repository. CC BY asks for this credit; CC0 doesn't, but it's given anyway.
 */

export const RADIO_STATION_NAME = 'Poke Agents Radio';

export const CC0_LICENSE = {
  name: 'CC0 1.0',
  url: 'https://creativecommons.org/publicdomain/zero/1.0/',
} as const;
export const CC_BY_4_LICENSE = {
  name: 'CC BY 4.0',
  url: 'https://creativecommons.org/licenses/by/4.0/',
} as const;

export type RadioLicense = typeof CC0_LICENSE | typeof CC_BY_4_LICENSE;

export interface RadioCredit {
  /** `radio-<slug>`: the track id on the wire and the cache file's name. */
  id: string;
  title: string;
  author: string;
  license: RadioLicense;
  /** The track's page, where its author published it and its license. */
  sourceUrl: string;
}

/** In the order the station lists them: towns, routes, indoors, night, battle. */
export const RADIO_CREDITS: readonly RadioCredit[] = [
  {
    id: 'radio-welcome-to-the-item-shop',
    title: 'Welcome to the Item Shop',
    author: 'congusbongus',
    license: CC0_LICENSE,
    sourceUrl: 'https://opengameart.org/content/welcome-to-the-item-shop',
  },
  {
    id: 'radio-my-street',
    title: 'My Street',
    author: 'congusbongus',
    license: CC0_LICENSE,
    sourceUrl: 'https://opengameart.org/content/my-street',
  },
  {
    id: 'radio-exploring-town',
    title: 'Exploring Town',
    author: 'Spring Spring',
    license: CC0_LICENSE,
    sourceUrl: 'https://opengameart.org/content/exploring-town',
  },
  {
    id: 'radio-village-2018',
    title: 'Village, 2018',
    author: 'Loyalty Freak Music (Komiku)',
    license: CC0_LICENSE,
    sourceUrl: 'https://opengameart.org/content/village-2018',
  },
  {
    id: 'radio-flowerbed-fields',
    title: 'Flowerbed Fields',
    author: 'Zane Little Music',
    license: CC0_LICENSE,
    sourceUrl: 'https://opengameart.org/content/flowerbed-fields-loop',
  },
  {
    id: 'radio-chill-overworld',
    title: 'Chill Overworld',
    author: 'ATMANAN',
    license: CC_BY_4_LICENSE,
    sourceUrl: 'https://opengameart.org/content/chill-overworld',
  },
  {
    id: 'radio-the-road-we-use-to-travel',
    title: 'The road we use to travel when we were kids',
    author: 'Loyalty Freak Music (Komiku)',
    license: CC0_LICENSE,
    sourceUrl: 'https://opengameart.org/content/the-road-we-use-to-travel-when-we-were-kids',
  },
  {
    id: 'radio-stocked-up-on-potions',
    title: 'Stocked Up on Potions',
    author: 'congusbongus',
    license: CC_BY_4_LICENSE,
    sourceUrl: 'https://opengameart.org/content/stocked-up-on-potions',
  },
  {
    id: 'radio-apple-cider',
    title: 'Apple Cider',
    author: 'Zane Little Music',
    license: CC0_LICENSE,
    sourceUrl: 'https://opengameart.org/content/apple-cider',
  },
  {
    id: 'radio-remember-the-time-we-use-to-play',
    title: 'Remember the time we use to play',
    author: 'Loyalty Freak Music (Komiku)',
    license: CC0_LICENSE,
    sourceUrl: 'https://opengameart.org/content/remember-the-time-we-use-to-play',
  },
  {
    id: 'radio-airship-serenity',
    title: 'Airship Serenity',
    author: 'Kevin MacLeod (incompetech.com)',
    license: CC_BY_4_LICENSE,
    sourceUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1600046',
  },
  {
    id: 'radio-rpg-battle-theme',
    title: '8-Bit RPG Battle/Encounter Theme',
    author: 'Wolfgang_',
    license: CC0_LICENSE,
    sourceUrl: 'https://opengameart.org/content/8-bit-rpg-battleencounter-theme',
  },
];
