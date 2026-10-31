import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  MusicAlbum,
  MusicLibrary,
  MusicSourceId,
  MusicStation,
} from '../../../core/src/messages.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { requestMusicLibrary, sendMusicCommand } from './actions.js';
import { MUSIC_APP_VOLUME_DEBOUNCE_MS, MUSIC_NOTICE_MS, MUSIC_STATION_ALL } from './constants.js';
import {
  playApp,
  playFolder,
  setAppVolume,
  setFolderVolume,
  setShuffle,
  skip,
  togglePlay,
} from './controls.js';
import {
  APP_NAMES,
  appNowPlaying,
  indexTracks,
  isMultiDisc,
  nowPlayingText,
  SOURCE_LABELS,
  trackCountLabel,
  trackNumberLabel,
} from './format.js';
import { Marquee } from './Marquee.js';
import { type AppSource, musicStore, pendingKey, sourceAvailable, useMusic } from './musicStore.js';
import { JUKEBOX_UI_ATTRIBUTE } from './resumeOnGesture.js';

const SOURCES: readonly MusicSourceId[] = ['folder', 'apple', 'spotify'];
const jukeboxAttrs = { [JUKEBOX_UI_ATTRIBUTE]: '' };

function Icon({ name, className = '' }: { name: string; className?: string }) {
  return (
    <span className={`material-symbols-sharp ${className}`} aria-hidden="true">
      {name}
    </span>
  );
}

/** A GBA menu row: the ▶ cursor marks the selected one. */
function MenuRow({
  selected,
  onClick,
  onDoubleClick,
  disabled = false,
  children,
  right,
  testId,
}: {
  selected: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  right?: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      onDoubleClick={disabled ? undefined : onDoubleClick}
      aria-pressed={selected}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      className={`flex items-center gap-4 w-full text-left py-3 pr-8 pl-2 border-none rounded-none ${
        disabled ? 'opacity-50 cursor-default' : 'cursor-pointer'
      } ${selected ? 'bg-active-bg' : 'bg-transparent hover:bg-btn-hover'}`}
    >
      <span className="w-14 shrink-0 flex justify-center text-sm">
        {selected ? <Icon name="play_arrow" /> : null}
      </span>
      <span className="flex-1 min-w-0 truncate">{children}</span>
      {right}
    </button>
  );
}

function ListBox({ children }: { children: ReactNode }) {
  return (
    <div className="border-2 border-border overflow-y-auto pixel-scrollbar h-[min(200px,24vh)] sm:h-[min(340px,42vh)] py-2">
      {children}
    </div>
  );
}

function Muted({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`text-2xs text-text-muted ${className}`}>{children}</span>;
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-8 pt-6 pb-2 text-2xs text-accent">{children}</div>;
}

function usePending(source: MusicSourceId, action: Parameters<typeof pendingKey>[1]): boolean {
  return useMusic((s) => s.pending[pendingKey(source, action)] === true);
}

// ── Source tabs ─────────────────────────────────────────────────

function SourceTabs({ library, tab }: { library: MusicLibrary; tab: MusicSourceId }) {
  const available = SOURCES.filter((id) => library.sources.some((s) => s.id === id && s.available));
  if (available.length <= 1) return null;
  return (
    <div className="flex gap-4" role="tablist">
      {available.map((id) => (
        <Button
          key={id}
          role="tab"
          aria-selected={tab === id}
          size="sm"
          variant={tab === id ? 'active' : 'default'}
          onClick={() => musicStore.setTab(id)}
          className="flex items-center gap-4"
        >
          {tab === id && <Icon name="play_arrow" className="text-xs" />}
          {SOURCE_LABELS[id]}
        </Button>
      ))}
    </div>
  );
}

// ── My music (folder) ───────────────────────────────────────────

function FolderEmpty({ folderPath }: { folderPath: string }) {
  return (
    <div className="flex flex-col gap-8 py-16 px-4 items-start" data-testid="music-folder-empty">
      <span>Put albums you own in {folderPath} (one folder per game).</span>
      <Muted>
        MP3, M4A/AAC, OGG/Opus, WAV and FLAC. Titles come from file names, like “03 - Route
        101.m4a”.
      </Muted>
      <FolderButtons />
    </div>
  );
}

function FolderButtons() {
  const opening = usePending('folder', 'openFolder');
  return (
    <div className="flex gap-4">
      <Button
        size="sm"
        variant={opening ? 'disabled' : 'default'}
        disabled={opening}
        onClick={() => sendMusicCommand({ action: 'openFolder', source: 'folder' })}
        className="flex items-center gap-4"
      >
        <Icon name="folder_open" />
        Open folder
      </Button>
      <Button size="sm" onClick={() => requestMusicLibrary()} className="flex items-center gap-4">
        <Icon name="refresh" />
        Rescan
      </Button>
    </div>
  );
}

function FolderTab({ library }: { library: MusicLibrary }) {
  const folder = useMusic((s) => s.folder);
  const albums = library.albums;
  const [selected, setSelected] = useState<string>(() =>
    folder.station === MUSIC_STATION_ALL || albums.some((a) => a.id === folder.station)
      ? (folder.station ?? MUSIC_STATION_ALL)
      : (albums[0]?.id ?? MUSIC_STATION_ALL),
  );
  const unplayable = useMemo(() => new Set(folder.unplayable), [folder.unplayable]);
  if (albums.length === 0) return <FolderEmpty folderPath={library.folderPath} />;

  const total = albums.reduce((n, a) => n + a.tracks.length, 0);
  const album = albums.find((a) => a.id === selected);
  const playingAll = folder.playing && folder.station === MUSIC_STATION_ALL;

  return (
    <div className="grid gap-8 grid-cols-1 sm:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <ListBox>
        <MenuRow
          selected={selected === MUSIC_STATION_ALL}
          onClick={() => {
            setSelected(MUSIC_STATION_ALL);
            playFolder(MUSIC_STATION_ALL, { shuffle: true });
          }}
          right={<Muted>{trackCountLabel(total)}</Muted>}
          testId="music-shuffle-all"
        >
          <span className="flex items-center gap-4">
            <Icon name="shuffle" className="text-accent" />
            Shuffle all
            {playingAll && <Icon name="volume_up" className="text-xs" />}
          </span>
        </MenuRow>
        {albums.map((a) => (
          <MenuRow
            key={a.id}
            selected={selected === a.id}
            onClick={() => setSelected(a.id)}
            onDoubleClick={() => playFolder(a.id)}
            right={
              folder.playing && folder.station === a.id ? (
                <Icon name="volume_up" className="text-xs" />
              ) : (
                <Muted>{a.tracks.length}</Muted>
              )
            }
          >
            {a.name}
          </MenuRow>
        ))}
      </ListBox>
      <div className="flex flex-col gap-6 min-w-0">
        {album ? (
          <AlbumTracks album={album} unplayable={unplayable} />
        ) : (
          <div className="flex flex-col gap-6 py-8">
            <span className="text-lg">All games</span>
            <Muted>
              {trackCountLabel(total)} in{' '}
              {albums.length === 1 ? '1 album' : `${albums.length} albums`}
            </Muted>
            <div className="flex gap-4">
              <Button size="sm" onClick={() => playFolder(MUSIC_STATION_ALL, { shuffle: true })}>
                Shuffle all
              </Button>
              <Button size="sm" onClick={() => playFolder(MUSIC_STATION_ALL, { shuffle: false })}>
                Play in order
              </Button>
            </div>
          </div>
        )}
        <div className="mt-auto flex items-center justify-between gap-8">
          <span className="text-2xs text-text-muted truncate min-w-0">{library.folderPath}</span>
          <FolderButtons />
        </div>
        {library.folderTruncated && <Muted>Showing the first tracks of a very large folder.</Muted>}
      </div>
    </div>
  );
}

function AlbumTracks({
  album,
  unplayable,
}: {
  album: MusicAlbum;
  unplayable: ReadonlySet<string>;
}) {
  const folder = useMusic((s) => s.folder);
  const multiDisc = isMultiDisc(album);
  const list = useRef<HTMLDivElement>(null);
  // Keep the playing track in view as the queue moves on.
  useEffect(() => {
    const row = list.current?.querySelector('[aria-pressed="true"]');
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [folder.trackId, album.id]);
  return (
    <>
      <div className="flex items-center justify-between gap-8">
        <div className="flex flex-col min-w-0">
          <span className="text-lg truncate" title={album.name}>
            {album.name}
          </span>
          <Muted>{trackCountLabel(album.tracks.length)}</Muted>
        </div>
        <div className="flex gap-4 shrink-0">
          <Button
            size="sm"
            onClick={() => playFolder(album.id, { shuffle: false })}
            className="flex items-center gap-4"
          >
            <Icon name="play_arrow" />
            Play
          </Button>
          <Button
            size="sm"
            onClick={() => playFolder(album.id, { shuffle: true })}
            className="flex items-center gap-4"
            data-testid="music-shuffle-game"
          >
            <Icon name="shuffle" />
            Shuffle this game
          </Button>
        </div>
      </div>
      <div
        ref={list}
        className="border-2 border-border overflow-y-auto pixel-scrollbar h-[min(160px,20vh)] sm:h-[min(240px,30vh)] py-2"
      >
        {album.tracks.map((track) => {
          const current = folder.trackId === track.id && folder.station !== null;
          const cantPlay = unplayable.has(track.id);
          return (
            <MenuRow
              key={track.id}
              selected={current}
              disabled={cantPlay}
              onClick={() => playFolder(album.id, { startId: track.id })}
              right={
                cantPlay ? (
                  <Muted>can’t play here</Muted>
                ) : current && folder.playing ? (
                  <Icon name="volume_up" className="text-xs" />
                ) : null
              }
            >
              <span className="text-text-muted mr-6 tabular-nums">
                {trackNumberLabel(track, multiDisc)}
              </span>
              {track.title}
            </MenuRow>
          );
        })}
      </div>
    </>
  );
}

// ── Saved links (Apple Music, Spotify) ──────────────────────────

function PasteLink({ source, placeholder }: { source: AppSource; placeholder: string }) {
  const [draft, setDraft] = useState('');
  const adding = usePending(source, 'addStation');
  const submit = () => {
    const uri = draft.trim();
    if (!uri || adding) return;
    sendMusicCommand({ action: 'addStation', source, uri });
    setDraft('');
  };
  return (
    <form
      className="flex items-center gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        type="text"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        aria-label={placeholder}
        className="flex-1 min-w-0 text-xs py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
      />
      <Button
        type="submit"
        size="sm"
        variant={adding || !draft.trim() ? 'disabled' : 'default'}
        disabled={adding || !draft.trim()}
        className="shrink-0"
      >
        {adding ? 'Adding…' : 'Add'}
      </Button>
    </form>
  );
}

function StationActions({ station }: { station: MusicStation }) {
  const source = station.source as AppSource;
  const opensInApp = source === 'apple';
  return (
    <div className="flex flex-col gap-6 py-8">
      <span className="text-lg break-words">{station.name}</span>
      <Muted>
        {station.kind === 'track' ? 'Track' : station.kind === 'album' ? 'Album' : 'Playlist'} ·{' '}
        {opensInApp ? 'opens in Music; press play there' : `plays in ${APP_NAMES[source]}`}
      </Muted>
      <div className="flex gap-4 flex-wrap">
        <Button
          size="sm"
          onClick={() => playApp(source, station.id, false)}
          className="flex items-center gap-4"
        >
          <Icon name={opensInApp ? 'open_in_new' : 'play_arrow'} />
          {opensInApp ? 'Open in Music' : 'Play'}
        </Button>
        {!opensInApp && station.kind !== 'track' && (
          <Button
            size="sm"
            onClick={() => playApp(source, station.id, true)}
            className="flex items-center gap-4"
          >
            <Icon name="shuffle" />
            Shuffle this
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            sendMusicCommand({ action: 'removeStation', source, stationId: station.id })
          }
        >
          Remove
        </Button>
      </div>
    </div>
  );
}

// ── Apple Music ─────────────────────────────────────────────────

function AppleTab({ library }: { library: MusicLibrary }) {
  const scanning = usePending('apple', 'scanLibrary');
  const albums = library.appleAlbums;
  const links = library.stations.filter((s) => s.source === 'apple');
  const [selected, setSelected] = useState<string | null>(null);
  const album = albums.find((a) => a.id === selected);
  const link = links.find((s) => s.id === selected);

  const scanButton = (
    <Button
      size="sm"
      variant={scanning ? 'disabled' : 'default'}
      disabled={scanning}
      onClick={() => sendMusicCommand({ action: 'scanLibrary', source: 'apple' })}
      className="flex items-center gap-4"
    >
      <Icon name="library_music" />
      {scanning
        ? 'Looking…'
        : library.appleLibraryScanned
          ? 'Look again'
          : 'Look in my Music library'}
    </Button>
  );

  return (
    <div className="grid gap-8 grid-cols-1 sm:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <ListBox>
        <MenuRow
          selected={false}
          onClick={() => playApp('apple', undefined, true)}
          testId="music-apple-shuffle-all"
        >
          <span className="flex items-center gap-4">
            <Icon name="shuffle" className="text-accent" />
            Shuffle all Pokémon albums
          </span>
        </MenuRow>
        {albums.map((a) => (
          <MenuRow
            key={a.id}
            selected={selected === a.id}
            onClick={() => setSelected(a.id)}
            onDoubleClick={() => playApp('apple', a.id, false)}
            right={<Muted>{a.trackCount}</Muted>}
          >
            {a.name}
          </MenuRow>
        ))}
        {links.length > 0 && <SectionLabel>Saved links</SectionLabel>}
        {links.map((s) => (
          <MenuRow
            key={s.id}
            selected={selected === s.id}
            onClick={() => setSelected(s.id)}
            right={<Icon name="link" className="text-xs text-text-muted" />}
          >
            {s.name}
          </MenuRow>
        ))}
      </ListBox>
      <div className="flex flex-col gap-6 min-w-0">
        {album ? (
          <div className="flex flex-col gap-6 py-8">
            <span className="text-lg break-words">{album.name}</span>
            <Muted>
              {[album.artist, trackCountLabel(album.trackCount)].filter(Boolean).join(' · ')}
            </Muted>
            <div className="flex gap-4 flex-wrap">
              <Button
                size="sm"
                onClick={() => playApp('apple', album.id, false)}
                className="flex items-center gap-4"
              >
                <Icon name="play_arrow" />
                Play
              </Button>
              <Button
                size="sm"
                onClick={() => playApp('apple', album.id, true)}
                className="flex items-center gap-4"
              >
                <Icon name="shuffle" />
                Shuffle this game
              </Button>
            </div>
          </div>
        ) : link ? (
          <StationActions station={link} />
        ) : (
          <div className="flex flex-col gap-8 py-8 items-start" data-testid="music-apple-empty">
            <span>
              {library.appleLibraryScanned && albums.length === 0
                ? 'No Pokémon albums in your Music library yet.'
                : 'Pokémon albums in your Music library show up here.'}
            </span>
            {scanButton}
            <Muted>macOS asks once to let Poke Agents control Music.</Muted>
          </div>
        )}
        <div className="mt-auto flex flex-col gap-4">
          {(album || link) && <div>{scanButton}</div>}
          <PasteLink source="apple" placeholder="Paste a music.apple.com link" />
        </div>
      </div>
    </div>
  );
}

// ── Spotify ─────────────────────────────────────────────────────

function SpotifyTab({ library }: { library: MusicLibrary }) {
  const links = library.stations.filter((s) => s.source === 'spotify');
  const [selected, setSelected] = useState<string | null>(links[0]?.id ?? null);
  const link = links.find((s) => s.id === selected) ?? links[0];
  return (
    <div className="grid gap-8 grid-cols-1 sm:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <ListBox>
        {links.length === 0 ? (
          <div className="px-8 py-8 flex flex-col gap-4" data-testid="music-spotify-empty">
            <span>Paste a Spotify link</span>
            <Muted>An album, playlist or track from open.spotify.com. It plays in Spotify.</Muted>
          </div>
        ) : (
          links.map((s) => (
            <MenuRow
              key={s.id}
              selected={link?.id === s.id}
              onClick={() => setSelected(s.id)}
              onDoubleClick={() => playApp('spotify', s.id, false)}
              right={<Muted>{s.kind}</Muted>}
            >
              {s.name}
            </MenuRow>
          ))
        )}
      </ListBox>
      <div className="flex flex-col gap-6 min-w-0">
        {link ? <StationActions station={link} /> : <div className="py-8" />}
        <div className="mt-auto">
          <PasteLink source="spotify" placeholder="Paste a Spotify link" />
        </div>
      </div>
    </div>
  );
}

// ── Now playing + controls ──────────────────────────────────────

function VolumeSlider({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
}) {
  const style = { '--range-fill': `${value}%` } as CSSProperties;
  return (
    <label className="flex items-center gap-4 shrink-0" title={`${label}: ${value}%`}>
      <Icon name={value === 0 ? 'volume_off' : 'volume_up'} />
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        className="pixel-range w-[120px]"
        style={style}
      />
    </label>
  );
}

function Controls({
  playing,
  shuffle,
  onToggle,
  onPrevious,
  onNext,
  onShuffle,
  volume,
  onVolume,
  canPlay,
}: {
  playing: boolean;
  shuffle: boolean;
  onToggle: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onShuffle: () => void;
  volume: number;
  onVolume: (value: number) => void;
  canPlay: boolean;
}) {
  return (
    <div className="flex items-center gap-6 flex-wrap">
      <Button
        size="sm"
        variant={canPlay ? 'default' : 'disabled'}
        onClick={onPrevious}
        title="Previous"
        aria-label="Previous"
        disabled={!canPlay}
      >
        <Icon name="skip_previous" className="block" />
      </Button>
      <Button
        size="sm"
        variant={canPlay ? 'accent' : 'disabled'}
        onClick={onToggle}
        title={playing ? 'Pause' : 'Play'}
        aria-label={playing ? 'Pause' : 'Play'}
        disabled={!canPlay}
        data-testid="music-play-pause"
      >
        <Icon name={playing ? 'pause' : 'play_arrow'} className="block" />
      </Button>
      <Button
        size="sm"
        variant={canPlay ? 'default' : 'disabled'}
        onClick={onNext}
        title="Next"
        aria-label="Next"
        disabled={!canPlay}
      >
        <Icon name="skip_next" className="block" />
      </Button>
      <Button
        size="sm"
        variant={shuffle ? 'active' : 'default'}
        onClick={onShuffle}
        aria-pressed={shuffle}
        className="flex items-center gap-4"
        title="Shuffle"
      >
        <Icon name="shuffle" />
        {shuffle ? 'Shuffle on' : 'Shuffle off'}
      </Button>
      <div className="flex-1" />
      <VolumeSlider value={volume} onChange={onVolume} label="Volume" />
    </div>
  );
}

function FolderNowPlaying({ library }: { library: MusicLibrary }) {
  const folder = useMusic((s) => s.folder);
  const tracks = useMemo(() => indexTracks(library), [library]);
  const ref = folder.trackId ? tracks.get(folder.trackId) : undefined;
  const text = ref ? nowPlayingText(ref.track.title, ref.album.name) : 'Nothing playing';
  return (
    <NowPlayingFrame text={text} source="folder">
      <Controls
        playing={folder.playing}
        shuffle={folder.shuffle}
        onToggle={() => {
          if (!folder.playing && !folder.station && library.albums.length > 0) {
            playFolder(MUSIC_STATION_ALL, { shuffle: true });
          } else togglePlay('folder');
        }}
        onPrevious={() => skip('folder', 'previous')}
        onNext={() => skip('folder', 'next')}
        onShuffle={() => setShuffle('folder', !folder.shuffle)}
        volume={Math.round(folder.volume * 100)}
        onVolume={(v) => setFolderVolume(v / 100)}
        canPlay={library.albums.length > 0}
      />
    </NowPlayingFrame>
  );
}

function AppNowPlaying({ source }: { source: AppSource }) {
  const state = useMusic((s) => s.apps[source]);
  const [volume, setVolume] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const shown = volume ?? state?.volume ?? 50;
  return (
    <NowPlayingFrame text={appNowPlaying(state, source)} source={source}>
      <Controls
        playing={state?.playing === true}
        shuffle={state?.shuffle === true}
        onToggle={() => togglePlay(source)}
        onPrevious={() => skip(source, 'previous')}
        onNext={() => skip(source, 'next')}
        onShuffle={() => setShuffle(source, state?.shuffle !== true)}
        volume={shown}
        onVolume={(v) => {
          setVolume(v);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            setAppVolume(source, v);
            setVolume(null);
          }, MUSIC_APP_VOLUME_DEBOUNCE_MS);
        }}
        canPlay
      />
    </NowPlayingFrame>
  );
}

function NowPlayingFrame({
  text,
  source,
  children,
}: {
  text: string;
  source: MusicSourceId;
  children: ReactNode;
}) {
  return (
    // Sticky: on a phone the lists above scroll under the controls instead of
    // pushing them below the fold.
    <div className="sticky bottom-0 z-10 bg-bg flex flex-col gap-6 pt-6 pb-4 border-t-2 border-border">
      <div
        className="flex items-center gap-6 py-3 px-8 border-2 border-border bg-btn-bg"
        data-testid="music-now-playing-line"
      >
        <Icon name="music_note" className="text-accent shrink-0" />
        <Marquee text={text} className="min-w-0 flex-1" />
        <Muted className="shrink-0">{SOURCE_LABELS[source]}</Muted>
      </div>
      {children}
    </div>
  );
}

function NoticeLine() {
  const notice = useMusic((s) => s.notice);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => musicStore.dismissNotice(notice.seq), MUSIC_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!notice) return null;
  return (
    <button
      type="button"
      role={notice.tone === 'error' ? 'alert' : 'status'}
      onClick={() => musicStore.dismissNotice(notice.seq)}
      className={`text-left text-xs py-2 px-8 border-2 bg-transparent cursor-pointer ${
        notice.tone === 'error' ? 'border-status-error' : 'border-border'
      }`}
      title="Dismiss"
    >
      {notice.text}
    </button>
  );
}

// ── Panel ───────────────────────────────────────────────────────

/** The Jukebox, in the GBA menu style: source tabs, games and tracks, and the
 *  now-playing bar with the controls. */
export function JukeboxPanel({ onClose }: { onClose: () => void }) {
  const library = useMusic((s) => s.library);
  const storedTab = useMusic((s) => s.tab);
  const tabUsable = useMusic((s) => sourceAvailable(s, s.tab));
  const tab: MusicSourceId = tabUsable ? storedTab : 'folder';
  // The controls follow what is playing; with nothing playing, the open tab.
  const playingSource = useMusic((s) =>
    s.activeSource === 'folder'
      ? s.folder.playing
        ? 'folder'
        : null
      : s.apps[s.activeSource]?.playing
        ? s.activeSource
        : null,
  );
  const footerSource: MusicSourceId = playingSource ?? tab;

  // Escape closes the Jukebox and nothing under it (capture, before the
  // Pokédex's own Escape handler).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const folderAvailable = library?.sources.some((s) => s.id === 'folder' && s.available);

  return (
    <div {...jukeboxAttrs}>
      <Modal
        isOpen
        onClose={onClose}
        title={
          <span className="flex items-center gap-8">
            <Icon name="music_note" />
            Jukebox
          </span>
        }
        className="w-[min(880px,100%)]"
      >
        <div className="flex flex-col gap-8 px-10 pb-8" data-testid="jukebox-panel">
          {library === null ? (
            <div className="py-16 text-text-muted">Loading…</div>
          ) : !folderAvailable ? (
            <div className="py-16 text-text-muted">The Jukebox needs the Poke Agents server.</div>
          ) : (
            <>
              <SourceTabs library={library} tab={tab} />
              {tab === 'folder' && <FolderTab library={library} />}
              {tab === 'apple' && <AppleTab library={library} />}
              {tab === 'spotify' && <SpotifyTab library={library} />}
              <NoticeLine />
              {footerSource === 'folder' ? (
                <FolderNowPlaying library={library} />
              ) : (
                <AppNowPlaying source={footerSource} />
              )}
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
