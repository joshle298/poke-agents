/**
 * Jukebox mock for the Vite dev server (browserMock.ts): a made-up library and
 * app state so the panel and the pill can be developed and screenshotted with
 * no server. Every "track", the radio's included, streams the same few seconds
 * of generated silence; there is no audio and no artwork in the repo.
 *
 * ?music=empty  nothing in the music folder, no saved links (empty states)
 * ?music=linux  only the radio and the music folder (no Music or Spotify app)
 * ?music=noradio  the radio off (--no-radio)
 */

import type {
  ClientMessage,
  MusicAlbum,
  MusicAppleAlbum,
  MusicLibrary,
  MusicRadioTrack,
  MusicState,
  MusicStation,
  ServerMessage,
} from '../../../core/src/messages.js';
import { RADIO_CREDITS } from '../../../core/src/radioCredits.js';
import { transport } from '../transport/index.js';
import { isPageSource } from './musicStore.js';
import { setMusicTrackUrlOverride } from './trackUrl.js';

const SILENCE_SECONDS = 20;
const SILENCE_RATE = 8_000;

/** A WAV of silence (8-bit mono PCM), as a blob URL. */
function silentWavUrl(seconds: number): string {
  const samples = seconds * SILENCE_RATE;
  const buffer = new ArrayBuffer(44 + samples);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SILENCE_RATE, true);
  view.setUint32(28, SILENCE_RATE, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, 'data');
  view.setUint32(40, samples, true);
  new Uint8Array(buffer, 44).fill(128);
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

let nextId = 1;
function mockId(): string {
  return (nextId++).toString(16).padStart(24, '0');
}

function album(name: string, titles: string[], discs = 1): MusicAlbum {
  const perDisc = Math.ceil(titles.length / discs);
  return {
    id: mockId(),
    name,
    tracks: titles.map((title, i) => ({
      id: mockId(),
      title,
      trackNumber: (i % perDisc) + 1,
      ...(discs > 1 ? { discNumber: Math.floor(i / perDisc) + 1 } : {}),
      mimeType: 'audio/mp4',
    })),
  };
}

const GENERIC_TITLES = [
  'Title Screen',
  'Opening',
  'Hometown',
  'Professor’s Lab',
  'First Route',
  'Wild Battle',
  'Pokémon Center',
  'Forest Path',
  'Trainer Battle',
  'Gym',
  'Gym Leader Battle',
  'Victory',
  'Cycling',
  'Surfing',
  'Champion Battle',
  'Ending',
];

function mockAlbums(): MusicAlbum[] {
  return [
    album('Pokémon Emerald', GENERIC_TITLES.slice(0, 12)),
    album('Pokémon HeartGold & SoulSilver', GENERIC_TITLES.slice(2, 14)),
    album('Pokémon Platinum', GENERIC_TITLES.slice(0, 10)),
    album('Pokémon Scarlet & Violet', GENERIC_TITLES, 2),
    album('Pokémon Sun & Moon', GENERIC_TITLES.slice(1, 15)),
    album('Pokémon X & Y', GENERIC_TITLES.slice(0, 16), 2),
  ];
}

/** The real station's titles and artists, playing silence. */
const RADIO_TRACKS: MusicRadioTrack[] = RADIO_CREDITS.map(({ id, title, author }) => ({
  id,
  title,
  artist: author,
  mimeType: 'audio/wav',
  gain: 1,
}));

const APPLE_ALBUMS: MusicAppleAlbum[] = [
  {
    id: 'a'.repeat(24),
    name: 'Pokémon Legends Super Music Collection',
    artist: 'Game Freak',
    trackCount: 42,
  },
  {
    id: 'b'.repeat(24),
    name: 'Pokémon Sword & Shield Super Music Collection',
    artist: 'Game Freak',
    trackCount: 64,
  },
];

const STATIONS: MusicStation[] = [
  {
    id: 'spotify-playlist-0000000000000000000001',
    source: 'spotify',
    kind: 'playlist',
    name: 'Made-up lo-fi study playlist',
    url: 'https://open.spotify.com/playlist/0000000000000000000001',
  },
];

export function installMusicMock(dispatch: (data: unknown) => void): void {
  const mode = new URLSearchParams(window.location.search).get('music');
  const silence = silentWavUrl(SILENCE_SECONDS);
  setMusicTrackUrlOverride(() => silence);

  const appsAvailable = mode !== 'linux';
  const radioOn = mode !== 'noradio';
  let appleScanned = false;
  let stations = mode === 'empty' ? [] : [...STATIONS];
  const albums = mode === 'empty' ? [] : mockAlbums();
  const apps: Record<'apple' | 'spotify', MusicState> = {
    apple: {
      type: 'musicState',
      source: 'apple',
      running: true,
      playing: false,
      shuffle: true,
      volume: 70,
    },
    spotify: { type: 'musicState', source: 'spotify', running: false, playing: false },
  };

  const library = (): MusicLibrary => ({
    type: 'musicLibrary',
    sources: [
      radioOn
        ? { id: 'radio', available: true }
        : { id: 'radio', available: false, reason: 'The radio is off (--no-radio).' },
      { id: 'folder', available: true },
      appsAvailable
        ? { id: 'apple', available: true }
        : { id: 'apple', available: false, reason: 'Music control needs macOS.' },
      appsAvailable
        ? { id: 'spotify', available: true }
        : { id: 'spotify', available: false, reason: 'Spotify control needs macOS.' },
    ],
    radioTracks: radioOn ? RADIO_TRACKS : [],
    folderPath: '~/.pixel-agents/music',
    albums,
    appleAlbums: appleScanned ? APPLE_ALBUMS : [],
    appleLibraryScanned: appleScanned,
    stations,
  });

  const reply = (msg: ServerMessage) => setTimeout(() => dispatch(msg), 80);
  const ok = (msg: Extract<ClientMessage, { type: 'musicCommand' }>) =>
    reply({ type: 'musicActionResult', action: msg.action, source: msg.source, ok: true });

  const previousSend = transport.send.bind(transport);
  transport.send = (msg: ClientMessage) => {
    previousSend(msg);
    if (msg.type === 'requestMusicLibrary') {
      reply(library());
      return;
    }
    if (msg.type !== 'musicCommand' || isPageSource(msg.source)) {
      if (msg.type === 'musicCommand') ok(msg);
      return;
    }
    const app = apps[msg.source];
    switch (msg.action) {
      case 'scanLibrary':
        appleScanned = true;
        ok(msg);
        reply(library());
        return;
      case 'addStation':
        reply({
          type: 'musicActionResult',
          action: msg.action,
          source: msg.source,
          ok: false,
          message: 'The dev mock does not save links.',
        });
        return;
      case 'removeStation':
        stations = stations.filter((s) => s.id !== msg.stationId);
        ok(msg);
        reply(library());
        return;
      case 'play':
      case 'resume':
        apps[msg.source] = {
          ...app,
          running: true,
          playing: true,
          track: 'Hometown',
          album: msg.source === 'apple' ? APPLE_ALBUMS[0].name : 'Made-up lo-fi study playlist',
          ...(msg.shuffle !== undefined ? { shuffle: msg.shuffle } : {}),
        };
        break;
      case 'pause':
        apps[msg.source] = { ...app, playing: false };
        break;
      case 'setShuffle':
        apps[msg.source] = { ...app, shuffle: msg.shuffle };
        break;
      case 'setVolume':
        apps[msg.source] = { ...app, volume: msg.volume };
        break;
      default:
        break;
    }
    ok(msg);
    reply(apps[msg.source]);
  };

  dispatch(library());
}
