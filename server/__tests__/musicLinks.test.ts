import { describe, expect, it } from 'vitest';

import { parseAppleMusicLink, parseSpotifyLink } from '../src/music/links.js';

const ID = '4aawyAB9vmqN3uQ7FjRGTy';

describe('parseSpotifyLink', () => {
  it('accepts spotify: URIs and open.spotify.com links, keeping only kind and id', () => {
    for (const kind of ['album', 'playlist', 'track'] as const) {
      expect(parseSpotifyLink(`spotify:${kind}:${ID}`)).toEqual({
        kind,
        id: ID,
        uri: `spotify:${kind}:${ID}`,
        url: `https://open.spotify.com/${kind}/${ID}`,
      });
    }
    expect(parseSpotifyLink(`https://open.spotify.com/album/${ID}?si=AbC-123_x`)?.uri).toBe(
      `spotify:album:${ID}`,
    );
    expect(parseSpotifyLink(`  https://open.spotify.com/intl-de/playlist/${ID}  `)?.uri).toBe(
      `spotify:playlist:${ID}`,
    );
    expect(parseSpotifyLink(`https://open.spotify.com/intl-pt-BR/track/${ID}/`)?.kind).toBe(
      'track',
    );
  });

  it('refuses anything else', () => {
    const bad = [
      '',
      'hello',
      `http://open.spotify.com/album/${ID}`,
      `https://open.spotify.com.evil.example/album/${ID}`,
      `https://evil.example/open.spotify.com/album/${ID}`,
      `https://open.spotify.com/artist/${ID}`,
      `https://open.spotify.com/show/${ID}`,
      `https://open.spotify.com/album/${ID.slice(1)}`,
      `https://open.spotify.com/album/${ID}x`,
      `https://open.spotify.com/album/${ID}#frag`,
      `https://open.spotify.com/album/${ID}?si=a b`,
      `https://open.spotify.com/album/${ID}?si="x"`,
      `spotify:album:${ID}\nspotify:track:${ID}`,
      `spotify:album:${ID}" & do shell script "say hi" & "`,
      `spotify:album:${ID} && rm -rf ~`,
      `spotify:user:alice:playlist:${ID}`,
      `javascript:alert(1)`,
      `https://open.spotify.com/album/${ID}\u0000`,
      `https://open.spotify.com/album/${ID}?${'a'.repeat(600)}`,
    ];
    for (const input of bad) expect(parseSpotifyLink(input), input).toBeNull();
    expect(parseSpotifyLink(undefined)).toBeNull();
    expect(parseSpotifyLink(42)).toBeNull();
  });
});

describe('parseAppleMusicLink', () => {
  it('accepts album and playlist links and rebuilds them', () => {
    expect(
      parseAppleMusicLink(
        'https://music.apple.com/us/album/pokemon-x-pokemon-y-super-music-collection/1234567890?i=111',
      ),
    ).toEqual({
      kind: 'album',
      storefront: 'us',
      id: '1234567890',
      url: 'https://music.apple.com/us/album/pokemon-x-pokemon-y-super-music-collection/1234567890',
      appUrl:
        'itmss://music.apple.com/us/album/pokemon-x-pokemon-y-super-music-collection/1234567890?app=music',
      slugName: 'Pokemon X Pokemon Y Super Music Collection',
    });
    const playlist = parseAppleMusicLink(
      'https://music.apple.com/jp/playlist/battle-mix/pl.u-AbCd1234XyZ',
    );
    expect(playlist?.kind).toBe('playlist');
    expect(playlist?.id).toBe('pl.u-AbCd1234XyZ');
    expect(parseAppleMusicLink('https://music.apple.com/gb/album/1234')?.url).toBe(
      'https://music.apple.com/gb/album/1234',
    );
    expect(
      parseAppleMusicLink('https://music.apple.com/fr/album/pok%C3%A9mon-rouge/42')?.slugName,
    ).toBe('Pokémon Rouge');
  });

  it('refuses anything else', () => {
    const bad = [
      'https://music.apple.com/us/artist/game-freak/123',
      'https://music.apple.com/us/song/title/123',
      'http://music.apple.com/us/album/x/123',
      'https://music.apple.com.evil.example/us/album/x/123',
      'https://itunes.apple.com/us/album/x/123',
      'https://music.apple.com/usa/album/x/123',
      'https://music.apple.com/us/album/x/pl.u-abc',
      'https://music.apple.com/us/playlist/x/123',
      'https://music.apple.com/us/album/x/123#top',
      'https://music.apple.com/us/album/x y/123',
      'https://music.apple.com/us/album/"x"/123',
      'itmss://music.apple.com/us/album/x/123',
      '',
    ];
    for (const input of bad) expect(parseAppleMusicLink(input), input).toBeNull();
  });

  it('keeps control characters out of a slug name', () => {
    const link = parseAppleMusicLink('https://music.apple.com/us/album/a%0Ab%00c/7');
    expect(link?.slugName).toBe('A B c');
  });
});
