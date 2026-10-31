/**
 * Browser runtime mock — fetches assets and injects the same postMessage
 * events the VS Code extension would send.
 *
 * In Vite dev, it prefers pre-decoded JSON endpoints from middleware.
 * In plain browser builds, it falls back to decoding PNGs at runtime.
 *
 * Only imported in browser runtime; tree-shaken from VS Code webview runtime.
 */

import { rgbaToHex } from '../../core/src/assets/colorUtils.ts';
import {
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CHAR_FRAMES_PER_ROW,
  CHARACTER_DIRECTIONS,
  FLOOR_TILE_SIZE,
  WALL_BITMASK_COUNT,
  WALL_GRID_COLS,
  WALL_PIECE_HEIGHT,
  WALL_PIECE_WIDTH,
} from '../../core/src/assets/constants.ts';
import type {
  AssetIndex,
  CatalogEntry,
  CharacterDirectionSprites,
} from '../../core/src/assets/types.ts';
import type {
  ClientMessage,
  ConductorScope,
  ConductorSessionSummary,
  ServerMessage,
  SessionDetail,
  SessionDetailEntry,
  SessionQuestion,
} from '../../core/src/messages.ts';
import { transport } from './transport/index.js';

interface MockPayload {
  characters: CharacterDirectionSprites[];
  floorSprites: string[][][];
  wallSets: string[][][][];
  carpetSets: string[][][][];
  furnitureCatalog: CatalogEntry[];
  furnitureSprites: Record<string, string[][]>;
  layout: unknown;
}

// ── Module-level state ─────────────────────────────────────────────────────────

let mockPayload: MockPayload | null = null;

// ── PNG decode helpers (browser fallback) ───────────────────────────────────

interface DecodedPng {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function getPixel(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const idx = (y * width + x) * 4;
  return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
}

function readSprite(
  png: DecodedPng,
  width: number,
  height: number,
  offsetX = 0,
  offsetY = 0,
): string[][] {
  const sprite: string[][] = [];
  for (let y = 0; y < height; y++) {
    const row: string[] = [];
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(png.data, png.width, offsetX + x, offsetY + y);
      row.push(rgbaToHex(r, g, b, a));
    }
    sprite.push(row);
  }
  return sprite;
}

async function decodePng(url: string): Promise<DecodedPng> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch PNG: ${url} (${res.status.toString()})`);
  }
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Failed to create 2d canvas context for PNG decode');
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: imageData.data };
}

async function fetchJsonOptional<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function getIndexedAssetPath(kind: 'characters' | 'floors' | 'walls', relPath: string): string {
  return relPath.startsWith(`${kind}/`) ? relPath : `${kind}/${relPath}`;
}

async function decodeCharactersFromPng(
  base: string,
  index: AssetIndex,
): Promise<CharacterDirectionSprites[]> {
  const sprites: CharacterDirectionSprites[] = [];
  for (const relPath of index.characters) {
    const png = await decodePng(`${base}assets/${getIndexedAssetPath('characters', relPath)}`);
    const byDir: CharacterDirectionSprites = { down: [], up: [], right: [] };

    for (let dirIdx = 0; dirIdx < CHARACTER_DIRECTIONS.length; dirIdx++) {
      const dir = CHARACTER_DIRECTIONS[dirIdx];
      const rowOffsetY = dirIdx * CHAR_FRAME_H;
      const frames: string[][][] = [];
      for (let frame = 0; frame < CHAR_FRAMES_PER_ROW; frame++) {
        frames.push(readSprite(png, CHAR_FRAME_W, CHAR_FRAME_H, frame * CHAR_FRAME_W, rowOffsetY));
      }
      byDir[dir] = frames;
    }

    sprites.push(byDir);
  }
  return sprites;
}

async function decodeFloorsFromPng(base: string, index: AssetIndex): Promise<string[][][]> {
  const floors: string[][][] = [];
  for (const relPath of index.floors) {
    const png = await decodePng(`${base}assets/${getIndexedAssetPath('floors', relPath)}`);
    floors.push(readSprite(png, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE));
  }
  return floors;
}

async function decodeWallsFromPng(base: string, index: AssetIndex): Promise<string[][][][]> {
  const wallSets: string[][][][] = [];
  for (const relPath of index.walls) {
    const png = await decodePng(`${base}assets/${getIndexedAssetPath('walls', relPath)}`);
    const set: string[][][] = [];
    for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
      const ox = (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
      const oy = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
      set.push(readSprite(png, WALL_PIECE_WIDTH, WALL_PIECE_HEIGHT, ox, oy));
    }
    wallSets.push(set);
  }
  return wallSets;
}

async function decodeFurnitureFromPng(
  base: string,
  catalog: CatalogEntry[],
): Promise<Record<string, string[][]>> {
  const sprites: Record<string, string[][]> = {};
  for (const entry of catalog) {
    const png = await decodePng(`${base}assets/${entry.furniturePath}`);
    sprites[entry.id] = readSprite(png, entry.width, entry.height);
  }
  return sprites;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Call before createRoot() in main.tsx.
 * Fetches all pre-decoded assets from the Vite dev server and stores them
 * for dispatchMockMessages().
 */
export async function initBrowserMock(): Promise<void> {
  console.log('[BrowserMock] Loading assets...');

  const base = import.meta.env.BASE_URL; // '/' in dev, '/sub/' with a subpath, './' in production

  const [assetIndex, catalog] = await Promise.all([
    fetch(`${base}assets/asset-index.json`).then((r) => r.json()) as Promise<AssetIndex>,
    fetch(`${base}assets/furniture-catalog.json`).then((r) => r.json()) as Promise<CatalogEntry[]>,
  ]);

  const shouldTryDecoded = import.meta.env.DEV;
  const [decodedCharacters, decodedFloors, decodedWalls, decodedFurniture] = shouldTryDecoded
    ? await Promise.all([
        fetchJsonOptional<CharacterDirectionSprites[]>(`${base}assets/decoded/characters.json`),
        fetchJsonOptional<string[][][]>(`${base}assets/decoded/floors.json`),
        fetchJsonOptional<string[][][][]>(`${base}assets/decoded/walls.json`),
        fetchJsonOptional<Record<string, string[][]>>(`${base}assets/decoded/furniture.json`),
      ])
    : [null, null, null, null];

  const hasDecoded = !!(decodedCharacters && decodedFloors && decodedWalls && decodedFurniture);

  if (!hasDecoded) {
    if (shouldTryDecoded) {
      console.log('[BrowserMock] Decoded JSON not found, decoding PNG assets in browser...');
    } else {
      console.log('[BrowserMock] Decoding PNG assets in browser...');
    }
  }

  const [characters, floorSprites, wallSets, furnitureSprites] = hasDecoded
    ? [decodedCharacters!, decodedFloors!, decodedWalls!, decodedFurniture!]
    : await Promise.all([
        decodeCharactersFromPng(base, assetIndex),
        decodeFloorsFromPng(base, assetIndex),
        decodeWallsFromPng(base, assetIndex),
        decodeFurnitureFromPng(base, catalog),
      ]);

  const layout = assetIndex.defaultLayout
    ? await fetch(`${base}assets/${assetIndex.defaultLayout}`).then((r) => r.json())
    : null;

  // Carpets only have a decoded-JSON endpoint (no PNG fallback / asset-index
  // entry); empty array is fine — the carpet tab just won't render variants.
  const carpetSets =
    (shouldTryDecoded
      ? await fetchJsonOptional<string[][][][]>(`${base}assets/decoded/carpets.json`)
      : null) ?? [];

  mockPayload = {
    characters,
    floorSprites,
    wallSets,
    carpetSets,
    furnitureCatalog: catalog,
    furnitureSprites,
    layout,
  };

  console.log(
    `[BrowserMock] Ready (${hasDecoded ? 'decoded-json' : 'browser-png-decode'}) — ${characters.length} chars, ${floorSprites.length} floors, ${wallSets.length} wall sets, ${carpetSets.length} carpets, ${catalog.length} furniture items`,
  );
}

/**
 * Call inside a useEffect in App.tsx -- after the window message listener
 * in useExtensionMessages has been registered.
 *
 * Only used in Vite dev mode (npm run dev). In standalone server mode and
 * VS Code mode, the server/extension sends all state over the transport.
 */
let mockDispatched = false;

export function dispatchMockMessages(): void {
  // StrictMode runs App's mount effect twice in dev; a second pass would
  // wrap transport.send again and answer every request twice.
  if (!mockPayload || mockDispatched) return;
  mockDispatched = true;

  const {
    characters,
    floorSprites,
    wallSets,
    carpetSets,
    furnitureCatalog,
    furnitureSprites,
    layout,
  } = mockPayload;

  function dispatch(data: unknown): void {
    window.dispatchEvent(new MessageEvent('message', { data }));
  }

  // Must match the load order defined in CLAUDE.md:
  // characterSpritesLoaded -> floorTilesLoaded -> wallTilesLoaded -> carpetTilesLoaded
  //   -> furnitureAssetsLoaded -> layoutLoaded
  dispatch({ type: 'characterSpritesLoaded', characters });
  dispatch({ type: 'floorTilesLoaded', sprites: floorSprites });
  dispatch({ type: 'wallTilesLoaded', sets: wallSets });
  dispatch({ type: 'carpetTilesLoaded', sets: carpetSets });
  dispatch({ type: 'furnitureAssetsLoaded', catalog: furnitureCatalog, sprites: furnitureSprites });
  dispatch({ type: 'layoutLoaded', layout });
  dispatch({
    type: 'settingsLoaded',
    soundEnabled: false,
    extensionVersion: '1.3.0',
    lastSeenVersion: '1.2',
  });

  console.log('[BrowserMock] Messages dispatched');

  dispatchMockConductor(dispatch);
  // Jukebox: a made-up library and silent audio (music/musicMock.ts).
  void import('./music/musicMock.js').then(({ installMusicMock }) => installMusicMock(dispatch));
}

// ── Conductor mock (Vite dev only) ─────────────────────────────────────────────
// A few synthetic Conductor sessions so the party bar, Pokédex (Overview and
// Chat, with history pages and a pending question), Sessions and PC Box can
// be developed and screenshotted without a server. Every name and message
// below is made up. No sprites ship or decode: species carry names and the
// local server's portrait URLs, which 404 on the Vite server, so portraits
// and characters fall back to the upstream art.
//
// ?conductor=off  no Conductor at all (the upstream Claude Code office)
// ?conductor=empty  connected, nobody in scope (empty-office state)
// ?conductor=auth  no sign-in found (authRequired)

interface MockAgent {
  id: number;
  sessionId: string;
  label: string;
  workspaceId: string;
  workspaceName: string;
  workspaceNumber: number;
  repo: string;
  model: string;
  harness: string;
  species: number;
  level: number;
  status: 'active' | 'waiting' | 'error';
  awaitingInput?: boolean;
  errorMessage?: string;
  tool?: { name: string; status: string };
  context?: [used: number, window: number];
  leadAgentId?: number;
  lastActivityMinutesAgo: number;
}

const MOCK_SPECIES: Record<number, string> = {
  4: 'Charmander',
  7: 'Squirtle',
  25: 'Pikachu',
  133: 'Eevee',
  150: 'Mewtwo',
};

const MOCK_AGENTS: MockAgent[] = [
  {
    id: 1,
    sessionId: 'mock-session-lead',
    label: 'Plan the auth refactor',
    workspaceId: 'mock-ws-41',
    workspaceName: 'auth-refactor',
    workspaceNumber: 41,
    repo: 'acme/web',
    model: 'claude-sonnet-4-5',
    harness: 'claude',
    species: 150,
    level: 23,
    status: 'active',
    tool: { name: 'Bash', status: 'Running conductor session list' },
    context: [118_000, 200_000],
    lastActivityMinutesAgo: 0,
  },
  {
    id: 2,
    sessionId: 'mock-session-redirect',
    label: 'Fix login redirect',
    workspaceId: 'mock-ws-42',
    workspaceName: 'login-redirect',
    workspaceNumber: 42,
    repo: 'acme/web',
    model: 'gpt-5-codex',
    harness: 'codex',
    species: 4,
    level: 12,
    status: 'waiting',
    awaitingInput: true,
    context: [204_000, 272_000],
    leadAgentId: 1,
    lastActivityMinutesAgo: 1,
  },
  {
    id: 3,
    sessionId: 'mock-session-tests',
    label: 'Write session tests',
    workspaceId: 'mock-ws-43',
    workspaceName: 'session-tests',
    workspaceNumber: 43,
    repo: 'acme/web',
    model: 'claude-sonnet-4-5',
    harness: 'claude',
    species: 7,
    level: 17,
    status: 'active',
    tool: { name: 'Edit', status: 'Editing session.test.ts' },
    context: [40_000, 200_000],
    leadAgentId: 1,
    lastActivityMinutesAgo: 0,
  },
  {
    id: 4,
    sessionId: 'mock-session-docs',
    label: 'Docs pass',
    workspaceId: 'mock-ws-12',
    workspaceName: 'docs-pass',
    workspaceNumber: 12,
    repo: 'acme/docs',
    model: 'claude-haiku-4-5',
    harness: 'claude',
    species: 25,
    level: 8,
    status: 'error',
    errorMessage: 'The model provider returned an overloaded error.',
    context: [180_000, 200_000],
    lastActivityMinutesAgo: 6,
  },
  {
    id: 5,
    sessionId: 'mock-session-deps',
    label: 'Dependency bumps',
    workspaceId: 'mock-ws-13',
    workspaceName: 'deps',
    workspaceNumber: 13,
    repo: 'acme/api',
    model: 'gpt-5',
    harness: 'codex',
    species: 133,
    level: 5,
    status: 'waiting',
    context: [22_000, 272_000],
    lastActivityMinutesAgo: 45,
  },
];

const MOCK_SCOPE: ConductorScope = {
  creator: 'me',
  activeWithinHours: 6,
  showIdle: true,
  maxSessions: 24,
};

function mockMinutesAgo(minutes: number): number {
  return Date.now() - minutes * 60_000;
}

function mockSessions(): ConductorSessionSummary[] {
  const inOffice: ConductorSessionSummary[] = MOCK_AGENTS.map((a) => ({
    sessionId: a.sessionId,
    label: a.label,
    workspaceId: a.workspaceId,
    workspaceName: a.workspaceName,
    workspaceNumber: a.workspaceNumber,
    repo: a.repo,
    model: a.model,
    harness: a.harness,
    status: a.status === 'active' ? 'working' : a.status === 'error' ? 'error' : 'idle',
    lastActivityAt: mockMinutesAgo(a.lastActivityMinutesAgo),
    hidden: false,
    pinned: a.id === 1,
    agentId: a.id,
    leadSessionId: a.leadAgentId
      ? MOCK_AGENTS.find((l) => l.id === a.leadAgentId)?.sessionId
      : undefined,
    externalUrl: `conductor://workspace?id=${a.workspaceId}&session=${a.sessionId}`,
    creatorName: 'Dev User',
  }));
  return [
    ...inOffice,
    {
      sessionId: 'mock-session-hidden',
      label: 'Spike: edge caching',
      workspaceId: 'mock-ws-44',
      workspaceName: 'edge-cache',
      workspaceNumber: 44,
      repo: 'acme/web',
      model: 'claude-sonnet-4-5',
      harness: 'claude',
      status: 'idle',
      lastActivityAt: mockMinutesAgo(90),
      hidden: true,
      creatorName: 'Dev User',
    },
    {
      sessionId: 'mock-session-teammate',
      label: 'Billing webhooks',
      workspaceId: 'mock-ws-7',
      workspaceName: 'billing-webhooks',
      workspaceNumber: 7,
      repo: 'acme/api',
      model: 'gpt-5-codex',
      harness: 'codex',
      status: 'working',
      lastActivityAt: mockMinutesAgo(3),
      hidden: true,
      creatorName: 'Another Dev',
    },
    {
      sessionId: 'mock-session-archived-1',
      label: 'Old onboarding flow',
      workspaceId: 'mock-ws-30',
      workspaceName: 'onboarding',
      workspaceNumber: 30,
      repo: 'acme/web',
      status: 'idle',
      hidden: false,
      archived: true,
      archivedAt: mockMinutesAgo(180),
      species: 133,
      shiny: false,
    },
    {
      sessionId: 'mock-session-archived-2',
      label: 'Upgrade CI runners',
      workspaceId: 'mock-ws-31',
      workspaceName: 'ci-runners',
      workspaceNumber: 31,
      repo: 'acme/infra',
      status: 'idle',
      hidden: false,
      archived: true,
      archivedAt: mockMinutesAgo(60 * 26),
      species: 4,
      shiny: false,
    },
    {
      sessionId: 'mock-session-archived-3',
      label: 'Try the new linter',
      workspaceId: 'mock-ws-32',
      workspaceName: 'lint-trial',
      workspaceNumber: 32,
      repo: 'acme/web',
      status: 'idle',
      hidden: false,
      archived: true,
      archivedAt: mockMinutesAgo(60 * 50),
    },
  ];
}

/** Lines of a made-up working session, oldest first, with stable keys. */
const MOCK_TURN_TOOLS: ReadonlyArray<[tool: string, text: string]> = [
  ['Read', 'Reading src/auth/session.ts'],
  ['Grep', 'Searching for redirectTo'],
  ['Edit', 'Editing src/auth/redirect.ts'],
  ['Bash', 'Running npm test'],
];

/** Messages sent from the Pokédex this page load, per agent: the mock
 *  conversation grows by them (and a short made-up acknowledgement). */
const mockSent = new Map<number, SessionDetailEntry[]>();

function mockConversation(agent: MockAgent): SessionDetailEntry[] {
  return [...mockScriptedConversation(agent), ...(mockSent.get(agent.id) ?? [])];
}

function mockScriptedConversation(agent: MockAgent): SessionDetailEntry[] {
  const peer = agent.leadAgentId ?? (agent.id === 1 ? 3 : undefined);
  const peerLabel = MOCK_AGENTS.find((a) => a.id === peer)?.label;
  const lines: Array<Omit<SessionDetailEntry, 'at' | 'key'>> = [
    {
      role: 'user',
      text: `Please take on: ${agent.label.toLowerCase()}. Notes: @[Planning notes.md](.context%2Fattachments%2Fplanning-notes.md)`,
    },
  ];
  for (let turn = 1; turn <= 6; turn++) {
    lines.push({
      role: 'assistant',
      text:
        turn === 1
          ? 'On it. I will read the relevant files first, then make the change and run the tests.'
          : `Step ${turn}: the change builds; checking the next file before running the suite again.`,
    });
    for (const [toolName, text] of MOCK_TURN_TOOLS.slice(0, 1 + (turn % 4))) {
      lines.push({ role: 'tool', toolName, text });
    }
    if (turn === 3) lines.push({ role: 'user', text: 'Keep the public API unchanged, please.' });
    if (turn === 4 && peer !== undefined) {
      lines.push({
        role: agent.leadAgentId ? 'peerIn' : 'peerOut',
        text: 'Status check: how far along are the tests?',
        peerId: peer,
        peerLabel,
      });
    }
  }
  lines.push({
    role: 'assistant',
    text:
      agent.status === 'error'
        ? 'The run stopped with a provider error.'
        : agent.awaitingInput
          ? 'Before I change the redirect: should it keep the original query string?'
          : 'Tests are green so far; continuing with the next file.',
  });
  const start = mockMinutesAgo(agent.lastActivityMinutesAgo + lines.length);
  return lines.map((line, i) => ({
    ...line,
    at: start + i * 60_000,
    key: `${agent.sessionId}:${i}`,
  }));
}

/** The pending question of the session waiting on its user. */
function mockQuestion(agent: MockAgent): SessionQuestion | undefined {
  // Any reply answers it.
  if (!agent.awaitingInput || mockSent.has(agent.id)) return undefined;
  return {
    kind: 'askUser',
    text: 'Should the login redirect keep the original query string?',
    options: ['Keep the query string', 'Drop it and send people to /home', 'Ask the lead first'],
  };
}

/** Lines the live detail carries (the server's ring keeps the newest). */
const MOCK_DETAIL_ENTRIES = 10;
/** Lines per history page. */
const MOCK_HISTORY_PAGE = 12;

function mockDetail(agent: MockAgent): SessionDetail {
  const all = mockConversation(agent);
  return {
    type: 'sessionDetail',
    id: agent.id,
    prompt: `${agent.label}. Context: @[Transcript of Planning.md](.context%2Fattachments%2Fplanning-transcript.md). Keep the change small, add tests, and report back to the lead session when done.`,
    entries: all.slice(-MOCK_DETAIL_ENTRIES),
    truncated: all.length > MOCK_DETAIL_ENTRIES,
    question: mockQuestion(agent),
  };
}

/** One history page older than `before` (an index cursor), oldest first. */
function mockHistory(agent: MockAgent, before: string | undefined): ServerMessage {
  const all = mockConversation(agent);
  const end = before === undefined ? all.length : Number(before);
  const start = Math.max(0, end - MOCK_HISTORY_PAGE);
  return {
    type: 'sessionHistory',
    id: agent.id,
    entries: all.slice(start, end),
    ...(start > 0 ? { before: String(start) } : {}),
    hasMore: start > 0,
  };
}

function dispatchMockConductor(dispatch: (data: unknown) => void): void {
  const mode = new URLSearchParams(window.location.search).get('conductor');
  if (mode === 'off') return;
  const send = (msg: ServerMessage) => dispatch(msg);

  send({
    type: 'providerCapabilities',
    readingTools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
    subagentToolNames: ['Task', 'Agent'],
    activeProviders: ['conductor'],
  });

  if (mode === 'auth') {
    // The Connect card: a key starting "bad" is rejected, any other is
    // accepted and the office then says it has nobody in scope.
    const signedOut: ServerMessage = {
      type: 'conductorStatus',
      state: 'authRequired',
      message: 'Open the office and connect with a Conductor API key, or set CONDUCTOR_API_KEY.',
      keyPageUrl: 'https://app.conductor.build/home/api-keys',
      keyStorage: 'keychain',
      scope: MOCK_SCOPE,
    };
    send(signedOut);
    const realSend = transport.send.bind(transport);
    transport.send = (msg: ClientMessage) => {
      realSend(msg);
      if (msg.type === 'connectConductor') {
        const rejected = msg.apiKey.trim().startsWith('bad');
        setTimeout(() => {
          if (!rejected) {
            send({
              type: 'conductorStatus',
              state: 'connected',
              account: 'dev@example.com',
              authSource: 'app',
              keyStorage: 'keychain',
              sessionCount: 0,
              visibleCount: 0,
              lastSyncAt: Date.now(),
              scope: MOCK_SCOPE,
            });
          }
          send({
            type: 'conductorActionResult',
            action: 'connect',
            ok: !rejected,
            message: rejected
              ? 'That key was rejected by Conductor.'
              : 'Connected as dev@example.com',
          });
        }, 600);
      } else if (msg.type === 'disconnectConductor') {
        setTimeout(() => {
          send(signedOut);
          send({
            type: 'conductorActionResult',
            action: 'disconnect',
            ok: true,
            message: 'Signed out.',
          });
        }, 300);
      }
    };
    return;
  }

  let sessions = mode === 'empty' ? [] : mockSessions();
  const status = (scope: ConductorScope): ServerMessage => ({
    type: 'conductorStatus',
    state: 'connected',
    account: 'dev@example.com',
    workspaceCount: 6,
    sessionCount: sessions.filter((s) => !s.archived).length,
    visibleCount: sessions.filter((s) => !s.archived && !s.hidden).length,
    lastSyncAt: Date.now(),
    scope,
  });
  let scope = MOCK_SCOPE;
  send(status(scope));
  send({ type: 'conductorSessions', sessions });
  if (mode === 'empty') return;

  for (const [dex, name] of Object.entries(MOCK_SPECIES)) {
    const dex4 = dex.padStart(4, '0');
    send({
      type: 'pokemonSpeciesLoaded',
      dex: Number(dex),
      shiny: false,
      name,
      shadowSize: 1,
      anims: {},
      portraits: { Normal: `/api/pokemon/${dex4}/portrait/Normal.png` },
      credits: { sprite: ['CHUNSOFT'], portrait: ['CHUNSOFT'], pageUrl: '' },
    });
  }

  for (const a of MOCK_AGENTS) {
    send({
      type: 'agentCreated',
      id: a.id,
      directoryName: a.repo.split('/')[1],
      isExternal: true,
      hooksOnly: true,
      providerId: 'conductor',
      label: a.label,
      species: a.species,
      level: a.level,
    });
    send({
      type: 'agentDetails',
      id: a.id,
      providerId: 'conductor',
      label: a.label,
      externalUrl: `conductor://workspace?id=${a.workspaceId}&session=${a.sessionId}`,
      model: a.model,
      harness: a.harness,
      conductorSessionId: a.sessionId,
      conductorWorkspaceId: a.workspaceId,
      conductorWorkspaceName: a.workspaceName,
      conductorWorkspaceNumber: a.workspaceNumber,
      repo: a.repo,
      creatorName: 'Dev User',
      messageCount: a.level * a.level * 4,
      lastActivityAt: mockMinutesAgo(a.lastActivityMinutesAgo),
      species: a.species,
      level: a.level,
    });
  }
  for (const a of MOCK_AGENTS) {
    if (a.leadAgentId !== undefined) {
      send({
        type: 'agentTeamInfo',
        id: a.id,
        agentName: a.label,
        leadAgentId: a.leadAgentId,
        teamUsesTmux: true,
      });
    } else if (MOCK_AGENTS.some((c) => c.leadAgentId === a.id)) {
      send({ type: 'agentTeamInfo', id: a.id, isTeamLead: true });
    }
    if (a.context) {
      send({
        type: 'agentContextUsage',
        id: a.id,
        contextTokens: a.context[0],
        maxContextTokens: a.context[1],
      });
    }
    if (a.tool) {
      send({
        type: 'agentToolStart',
        id: a.id,
        toolId: `mock-tool-${a.id}`,
        status: a.tool.status,
        toolName: a.tool.name,
      });
    }
    send({
      type: 'agentStatus',
      id: a.id,
      status: a.status,
      awaitingInput: a.awaitingInput,
      errorMessage: a.errorMessage,
      silent: true,
    });
    send(mockDetail(a));
  }
  send({
    type: 'agentLinks',
    links: [
      { fromId: 1, toId: 2, kind: 'spawned', count: 1, lastAt: mockMinutesAgo(30) },
      { fromId: 1, toId: 3, kind: 'spawned', count: 1, lastAt: mockMinutesAgo(30) },
      {
        fromId: 3,
        toId: 1,
        kind: 'messaged',
        count: 2,
        lastAt: mockMinutesAgo(12),
        preview: 'Tests are green so far',
      },
    ],
  });

  // Answer the chrome's requests the way the server would.
  const reply = (msg: ServerMessage) => setTimeout(() => send(msg), 80);
  const ok =
    (action: Extract<ServerMessage, { type: 'conductorActionResult' }>['action']) =>
    (id?: number) =>
      reply({ type: 'conductorActionResult', action, id, ok: true });
  const realSend = transport.send.bind(transport);
  transport.send = (msg: ClientMessage) => {
    realSend(msg);
    switch (msg.type) {
      case 'requestSessionDetail': {
        const agent = MOCK_AGENTS.find((a) => a.id === msg.id);
        if (agent) reply(mockDetail(agent));
        break;
      }
      case 'requestSessionHistory': {
        const agent = MOCK_AGENTS.find((a) => a.id === msg.id);
        // Slower than the detail, so "Loading…" shows.
        if (agent) setTimeout(() => send(mockHistory(agent, msg.before)), 600);
        break;
      }
      case 'requestConductorSessions':
        reply({ type: 'conductorSessions', sessions });
        break;
      case 'setSessionHidden':
      case 'setSessionPinned':
        sessions = sessions.map((s) =>
          s.sessionId !== msg.sessionId
            ? s
            : msg.type === 'setSessionHidden'
              ? { ...s, hidden: msg.hidden }
              : { ...s, pinned: msg.pinned },
        );
        reply({ type: 'conductorSessions', sessions });
        reply(status(scope));
        break;
      case 'setConductorScope':
        scope = msg.scope;
        reply(status(scope));
        break;
      case 'archiveSession': {
        const session = sessions.find((s) => s.sessionId === msg.sessionId);
        sessions = sessions.map((s) =>
          s.sessionId === msg.sessionId
            ? { ...s, archived: true, archivedAt: Date.now(), agentId: undefined }
            : s,
        );
        if (session?.agentId !== undefined) {
          reply({ type: 'agentClosed', id: session.agentId });
          ok('archiveSession')(session.agentId);
        }
        reply({ type: 'conductorSessions', sessions });
        break;
      }
      case 'restoreSession':
        sessions = sessions.map((s) =>
          s.sessionId === msg.sessionId ? { ...s, archived: false, archivedAt: undefined } : s,
        );
        ok('restoreSession')();
        reply({ type: 'conductorSessions', sessions });
        break;
      case 'sendSessionMessage': {
        ok('sendSessionMessage')(msg.id);
        const agent = MOCK_AGENTS.find((a) => a.id === msg.id);
        if (!agent) break;
        const sent = mockSent.get(agent.id) ?? [];
        const at = Date.now();
        sent.push(
          { role: 'user', text: msg.text, at, key: `${agent.sessionId}:sent:${at}` },
          {
            role: 'assistant',
            text: 'Got it, carrying on with that.',
            at: at + 1,
            key: `${agent.sessionId}:ack:${at}`,
          },
        );
        mockSent.set(agent.id, sent);
        reply(mockDetail(agent));
        break;
      }
      case 'stopSession':
        ok('stopSession')(msg.id);
        reply({ type: 'agentStatus', id: msg.id, status: 'waiting' });
        break;
      case 'setPokemonTheme':
        reply({ type: 'pokemonThemeUpdated', enabled: msg.enabled });
        break;
      default:
        break;
    }
  };

  // A little live traffic for the battle log and the activity lines: tool
  // calls (each finishing before the next) and messages between sessions.
  const liveTools = [
    { id: 3, name: 'Bash', status: 'Running npm test' },
    { id: 1, name: 'Read', status: 'Reading session.ts' },
    { id: 3, name: 'Edit', status: 'Editing session.test.ts' },
  ];
  let tick = 0;
  let lastTool: { id: number; toolId: string } | null = null;
  setInterval(() => {
    tick += 1;
    if (tick % 2 === 0) {
      const [fromId, toId] = tick % 4 === 0 ? [1, 3] : [3, 1];
      send({ type: 'agentMessage', fromId, toId, kind: 'messaged', at: Date.now() });
      return;
    }
    if (lastTool) send({ type: 'agentToolDone', id: lastTool.id, toolId: lastTool.toolId });
    const tool = liveTools[(tick >> 1) % liveTools.length];
    const toolId = `mock-live-${tick}`;
    lastTool = { id: tool.id, toolId };
    send({ type: 'agentToolStart', id: tool.id, toolId, status: tool.status, toolName: tool.name });
  }, 3_000);
}
