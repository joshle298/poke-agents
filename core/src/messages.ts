/**
 * AUTO-GENERATED FROM core/asyncapi.yaml. DO NOT EDIT MANUALLY.
 *
 * Run `npm run asyncapi:generate` to regenerate.
 *
 * Source of truth: the yaml at core/asyncapi.yaml.
 * Editors and clients in any language can consume the spec directly.
 */

export type ServerMessage =
  | ProviderCapabilities
  | AgentCreated
  | AgentClosed
  | AgentSelected
  | ExistingAgents
  | AgentStatus
  | AgentToolStart
  | AgentToolDone
  | AgentToolsClear
  | AgentToolPermission
  | AgentToolPermissionClear
  | SubagentToolStart
  | SubagentToolDone
  | SubagentClear
  | SubagentToolPermission
  | AgentTeamInfo
  | AgentContextUsage
  | AgentDetails
  | AgentLinks
  | AgentMessage
  | AgentNotice
  | SessionDetail
  | SessionHistory
  | ConductorStatus
  | ConductorSessions
  | ConductorActionResult
  | LayoutLoaded
  | FurnitureAssetsLoaded
  | CharacterSpritesLoaded
  | PetSpritesLoaded
  | PokemonSpeciesLoaded
  | PokemonSpeciesFailed
  | FloorTilesLoaded
  | WallTilesLoaded
  | CarpetTilesLoaded
  | OfficeAccess
  | SettingsLoaded
  | BypassPermissionsUpdated
  | PokemonThemeUpdated
  | HooksStatus
  | HooksConsentRequest
  | ExternalAssetDirectoriesUpdated
  | AreaMappingsLoaded
  | DirectoriesLoaded
  | DirectorySaved
  | DirectoryRejected
  | DirectorySuggestions
  | TerminalAvailability
  | TerminalSessionOpened
  | TerminalSessionClosed
  | AgentDiagnostics
  | MusicLibrary
  | MusicState
  | MusicActionResult;

export type ClientMessage =
  | WebviewReady
  | LaunchAgent
  | FocusAgent
  | CloseAgent
  | SaveAgentSeats
  | SaveLayout
  | SetSoundEnabled
  | SetLastSeenVersion
  | SetAlwaysShowLabels
  | SetGhostHeadlessAgents
  | SetHooksEnabled
  | HooksConsentResponse
  | SetHooksInfoShown
  | SetWatchAllSessions
  | ExportLayout
  | ImportLayout
  | OpenSessionsFolder
  | AddExternalAssetDirectory
  | RemoveExternalAssetDirectory
  | SaveAreaMappings
  | SetShowAreas
  | SetBypassPermissions
  | SetShowHostDirectories
  | SaveDirectory
  | RemoveDirectory
  | RequestDirectorySuggestions
  | RequestDiagnostics
  | SetPokemonTheme
  | OpenExternal
  | RequestSessionDetail
  | SendSessionMessage
  | StopSession
  | RequestConductorSessions
  | SetConductorScope
  | SetSessionHidden
  | SetSessionPinned
  | ArchiveSession
  | RestoreSession
  | RequestSessionHistory
  | RequestMusicLibrary
  | MusicCommand;

export interface ProviderCapabilities {
  type: 'providerCapabilities';
  readingTools: string[];
  subagentToolNames: string[];
  activeProviders?: string[];
}

export interface AgentCreated {
  type: 'agentCreated';
  id: number;
  directoryName?: string;
  isExternal?: boolean;
  palette?: number;
  hueShift?: number;
  isTeammate?: boolean;
  teammateName?: string;
  parentAgentId?: number;
  teamName?: string;
  hooksOnly?: boolean;
  providerId?: string;
  label?: string;
  seatId?: string;
  species?: number;
  shiny?: boolean;
  level?: number;
}

export interface AgentClosed {
  type: 'agentClosed';
  id: number;
}

export interface AgentSelected {
  type: 'agentSelected';
  id: number;
}

export interface ExistingAgents {
  type: 'existingAgents';
  agents: number[];
  agentMeta: Record<string, AgentSeatMeta>;
  directoryNames: Record<string, string>;
  externalAgents: Record<string, boolean>;
}

export interface AgentSeatMeta {
  palette?: number;
  hueShift?: number;
  seatId?: string;
  species?: number;
  shiny?: boolean;
}

export interface AgentStatus {
  type: 'agentStatus';
  id: number;
  status: AgentActivityStatus;
  awaitingInput?: boolean;
  errorMessage?: string;
  silent?: boolean;
}

export type AgentActivityStatus = 'active' | 'waiting' | 'error';

export interface AgentToolStart {
  type: 'agentToolStart';
  id: number;
  toolId: string;
  status: string;
  toolName?: string;
  permissionActive?: boolean;
  runInBackground?: boolean;
  isTeammateSpawn?: boolean;
}

export interface AgentToolDone {
  type: 'agentToolDone';
  id: number;
  toolId: string;
}

export interface AgentToolsClear {
  type: 'agentToolsClear';
  id: number;
}

export interface AgentToolPermission {
  type: 'agentToolPermission';
  id: number;
}

export interface AgentToolPermissionClear {
  type: 'agentToolPermissionClear';
  id: number;
}

export interface SubagentToolStart {
  type: 'subagentToolStart';
  id: number;
  parentToolId: string;
  toolId: string;
  status: string;
}

export interface SubagentToolDone {
  type: 'subagentToolDone';
  id: number;
  parentToolId: string;
  toolId: string;
}

export interface SubagentClear {
  type: 'subagentClear';
  id: number;
  parentToolId: string;
}

export interface SubagentToolPermission {
  type: 'subagentToolPermission';
  id: number;
  parentToolId: string;
}

export interface AgentTeamInfo {
  type: 'agentTeamInfo';
  id: number;
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  teamUsesTmux?: boolean;
}

export interface AgentContextUsage {
  type: 'agentContextUsage';
  id: number;
  contextTokens: number;
  maxContextTokens: number;
}

export interface AgentDetails {
  type: 'agentDetails';
  id: number;
  providerId?: string;
  label?: string;
  externalUrl?: string;
  model?: string;
  harness?: string;
  conductorSessionId?: string;
  conductorWorkspaceId?: string;
  conductorWorkspaceName?: string;
  conductorWorkspaceNumber?: number;
  repo?: string;
  creatorName?: string;
  messageCount?: number;
  lastActivityAt?: number;
  species?: number;
  shiny?: boolean;
  level?: number;
}

export interface AgentLinks {
  type: 'agentLinks';
  links: AgentLink[];
}

export interface AgentLink {
  fromId: number;
  toId: number;
  kind: AgentLinkKind;
  count: number;
  lastAt: number;
  preview?: string;
}

export type AgentLinkKind = 'spawned' | 'messaged' | 'watched';

export interface AgentMessage {
  type: 'agentMessage';
  fromId: number;
  toId: number;
  kind: AgentLinkKind;
  preview?: string;
  at: number;
}

export interface AgentNotice {
  type: 'agentNotice';
  id: number;
  text: string;
  at: number;
  tone?: AgentNoticeTone;
}

export type AgentNoticeTone = 'info' | 'error';

export interface SessionDetail {
  type: 'sessionDetail';
  id: number;
  prompt?: string;
  entries: SessionDetailEntry[];
  truncated?: boolean;
  question?: SessionQuestion;
}

export interface SessionDetailEntry {
  role: SessionDetailRole;
  text: string;
  at: number;
  peerId?: number;
  peerLabel?: string;
  toolName?: string;
  key?: string;
}

export type SessionDetailRole = 'user' | 'assistant' | 'tool' | 'peerIn' | 'peerOut';

export interface SessionQuestion {
  kind: SessionQuestionKind;
  text: string;
  options?: string[];
}

export type SessionQuestionKind = 'askUser' | 'plan' | 'notice';

export interface SessionHistory {
  type: 'sessionHistory';
  id: number;
  entries: SessionDetailEntry[];
  before?: string;
  hasMore: boolean;
  error?: string;
}

export interface ConductorStatus {
  type: 'conductorStatus';
  state: ConductorConnectionState;
  message?: string;
  account?: string;
  workspaceCount?: number;
  sessionCount?: number;
  visibleCount?: number;
  lastSyncAt?: number;
  scope: ConductorScope;
}

export type ConductorConnectionState =
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'authRequired'
  | 'unauthorized'
  | 'unreachable'
  | 'rateLimited';

export interface ConductorScope {
  creator: ConductorCreatorScope;
  activeWithinHours: number;
  showIdle: boolean;
  maxSessions: number;
}

export type ConductorCreatorScope = 'me' | 'all';

export interface ConductorSessions {
  type: 'conductorSessions';
  sessions: ConductorSessionSummary[];
}

export interface ConductorSessionSummary {
  sessionId: string;
  label: string;
  workspaceId: string;
  workspaceName: string;
  workspaceNumber?: number;
  repo?: string;
  model?: string;
  harness?: string;
  status: ConductorSessionStatus;
  lastActivityAt?: number;
  hidden: boolean;
  pinned?: boolean;
  archived?: boolean;
  species?: number;
  shiny?: boolean;
  archivedAt?: number;
  agentId?: number;
  leadSessionId?: string;
  externalUrl?: string;
  creatorName?: string;
}

export type ConductorSessionStatus = 'idle' | 'working' | 'error';

export interface ConductorActionResult {
  type: 'conductorActionResult';
  action: ConductorAction;
  id?: number;
  ok: boolean;
  message?: string;
}

export type ConductorAction =
  | 'sendSessionMessage'
  | 'stopSession'
  | 'openExternal'
  | 'setSessionHidden'
  | 'setSessionPinned'
  | 'setConductorScope'
  | 'archiveSession'
  | 'restoreSession';

export interface LayoutLoaded {
  type: 'layoutLoaded';
  layout: Record<string, any> | null;
  wasReset?: boolean;
}

export interface FurnitureAssetsLoaded {
  type: 'furnitureAssetsLoaded';
  catalog: FurnitureAssetMessage[];
  sprites: Record<string, string[][]>;
}

export interface FurnitureAssetMessage {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  groupId?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
}

export interface CharacterSpritesLoaded {
  type: 'characterSpritesLoaded';
  characters: CharacterSpriteSet[];
}

export interface CharacterSpriteSet {
  down: string[][][];
  up: string[][][];
  right: string[][][];
}

export interface PetSpritesLoaded {
  type: 'petSpritesLoaded';
  pets: PetSpriteFrameSet[];
  petNames: string[];
}

export interface PetSpriteFrameSet {
  walkDown: string[][][];
  idleDown: string[][][];
  walkUp: string[][][];
  idleUp: string[][][];
  walkRight: string[][][];
}

export interface PokemonSpeciesLoaded {
  type: 'pokemonSpeciesLoaded';
  dex: number;
  shiny: boolean;
  name: string;
  shadowSize: number;
  anims: Record<string, PokemonAnim>;
  portraits: Record<string, string>;
  credits: PokemonCredits;
  cry?: string;
}

export interface PokemonAnim {
  url: string;
  frameWidth: number;
  frameHeight: number;
  frames: number;
  directions: number;
  durations: number[];
  rushFrame?: number;
  hitFrame?: number;
  returnFrame?: number;
}

export interface PokemonCredits {
  sprite: string[];
  portrait: string[];
  pageUrl: string;
}

export interface PokemonSpeciesFailed {
  type: 'pokemonSpeciesFailed';
  dex: number;
  shiny: boolean;
}

export interface FloorTilesLoaded {
  type: 'floorTilesLoaded';
  sprites: string[][][];
}

export interface WallTilesLoaded {
  type: 'wallTilesLoaded';
  sets: string[][][][];
}

export interface CarpetTilesLoaded {
  type: 'carpetTilesLoaded';
  sets: string[][][][];
}

export interface OfficeAccess {
  type: 'officeAccess';
  readOnly: boolean;
}

export interface SettingsLoaded {
  type: 'settingsLoaded';
  soundEnabled: boolean;
  lastSeenVersion: string;
  extensionVersion: string;
  watchAllSessions: boolean;
  alwaysShowLabels: boolean;
  ghostHeadlessAgents: boolean;
  hooksEnabled: boolean;
  hooksInfoShown: boolean;
  externalAssetDirectories: string[];
  showAreas: boolean;
  bypassPermissions: boolean;
  showHostDirectories: boolean;
  pokemonTheme?: boolean;
  pokemonSprites?: boolean;
}

export interface BypassPermissionsUpdated {
  type: 'bypassPermissionsUpdated';
  enabled: boolean;
}

export interface PokemonThemeUpdated {
  type: 'pokemonThemeUpdated';
  enabled: boolean;
}

export interface HooksStatus {
  type: 'hooksStatus';
  providerId: string;
  installed: boolean;
}

export interface HooksConsentRequest {
  type: 'hooksConsentRequest';
  providerId: string;
  headline: string;
  disclosure: string;
}

export interface ExternalAssetDirectoriesUpdated {
  type: 'externalAssetDirectoriesUpdated';
  dirs: string[];
}

export interface AreaMappingsLoaded {
  type: 'areaMappingsLoaded';
  mappings: Record<string, string[]>;
}

export interface DirectoriesLoaded {
  type: 'directoriesLoaded';
  directories: Directory[];
}

export interface Directory {
  name: string;
  path: string;
  source: DirectorySource;
}

export type DirectorySource = 'user' | 'host';

export interface DirectorySaved {
  type: 'directorySaved';
  directory: Directory;
}

export interface DirectoryRejected {
  type: 'directoryRejected';
  path: string;
  reason: string;
}

export interface DirectorySuggestions {
  type: 'directorySuggestions';
  paths: string[];
}

export interface TerminalAvailability {
  type: 'terminalAvailability';
  available: boolean;
  reason?: string;
}

export interface TerminalSessionOpened {
  type: 'terminalSessionOpened';
  agentId: number;
}

export interface TerminalSessionClosed {
  type: 'terminalSessionClosed';
  agentId: number;
  exitCode?: number;
}

export interface AgentDiagnostics {
  type: 'agentDiagnostics';
  agents: Record<string, any>[];
}

export interface MusicLibrary {
  type: 'musicLibrary';
  sources: MusicSourceInfo[];
  radioTracks: MusicRadioTrack[];
  folderPath: string;
  folderTruncated?: boolean;
  albums: MusicAlbum[];
  appleAlbums: MusicAppleAlbum[];
  appleLibraryScanned: boolean;
  stations: MusicStation[];
}

export interface MusicSourceInfo {
  id: MusicSourceId;
  available: boolean;
  reason?: string;
}

export type MusicSourceId = 'radio' | 'folder' | 'apple' | 'spotify';

export interface MusicRadioTrack {
  id: string;
  title: string;
  artist: string;
  mimeType: string;
  gain: number;
}

export interface MusicAlbum {
  id: string;
  name: string;
  tracks: MusicTrack[];
}

export interface MusicTrack {
  id: string;
  title: string;
  trackNumber?: number;
  discNumber?: number;
  mimeType: string;
}

export interface MusicAppleAlbum {
  id: string;
  name: string;
  artist?: string;
  trackCount: number;
}

export interface MusicStation {
  id: string;
  source: MusicSourceId;
  kind: MusicStationKind;
  name: string;
  url: string;
}

export type MusicStationKind = 'album' | 'playlist' | 'track';

export interface MusicState {
  type: 'musicState';
  source: MusicSourceId;
  running: boolean;
  playing: boolean;
  track?: string;
  album?: string;
  artist?: string;
  shuffle?: boolean;
  volume?: number;
  error?: string;
}

export interface MusicActionResult {
  type: 'musicActionResult';
  action: MusicCommandAction;
  source: MusicSourceId;
  ok: boolean;
  message?: string;
}

export type MusicCommandAction =
  | 'play'
  | 'pause'
  | 'resume'
  | 'next'
  | 'previous'
  | 'setShuffle'
  | 'setVolume'
  | 'refresh'
  | 'scanLibrary'
  | 'addStation'
  | 'removeStation'
  | 'openFolder';

export interface WebviewReady {
  type: 'webviewReady';
}

export interface LaunchAgent {
  type: 'launchAgent';
  directoryPath?: string;
}

export interface FocusAgent {
  type: 'focusAgent';
  id: number;
}

export interface CloseAgent {
  type: 'closeAgent';
  id: number;
}

export interface SaveAgentSeats {
  type: 'saveAgentSeats';
  seats: Record<string, SeatAssignment>;
}

export interface SeatAssignment {
  palette: number;
  hueShift: number;
  seatId: string | null;
  species?: number;
  shiny?: boolean;
}

export interface SaveLayout {
  type: 'saveLayout';
  layout: Record<string, any>;
}

export interface SetSoundEnabled {
  type: 'setSoundEnabled';
  enabled: boolean;
}

export interface SetLastSeenVersion {
  type: 'setLastSeenVersion';
  version: string;
}

export interface SetAlwaysShowLabels {
  type: 'setAlwaysShowLabels';
  enabled: boolean;
}

export interface SetGhostHeadlessAgents {
  type: 'setGhostHeadlessAgents';
  enabled: boolean;
}

export interface SetHooksEnabled {
  type: 'setHooksEnabled';
  providerId: string;
  enabled: boolean;
}

export interface HooksConsentResponse {
  type: 'hooksConsentResponse';
  providerId: string;
  choice: HooksConsentChoice;
}

export type HooksConsentChoice = 'install' | 'notNow' | 'never';

export interface SetHooksInfoShown {
  type: 'setHooksInfoShown';
}

export interface SetWatchAllSessions {
  type: 'setWatchAllSessions';
  enabled: boolean;
}

export interface ExportLayout {
  type: 'exportLayout';
}

export interface ImportLayout {
  type: 'importLayout';
}

export interface OpenSessionsFolder {
  type: 'openSessionsFolder';
}

export interface AddExternalAssetDirectory {
  type: 'addExternalAssetDirectory';
  path?: string;
}

export interface RemoveExternalAssetDirectory {
  type: 'removeExternalAssetDirectory';
  path: string;
}

export interface SaveAreaMappings {
  type: 'saveAreaMappings';
  mappings: Record<string, string[]>;
}

export interface SetShowAreas {
  type: 'setShowAreas';
  enabled: boolean;
}

export interface SetBypassPermissions {
  type: 'setBypassPermissions';
  enabled: boolean;
}

export interface SetShowHostDirectories {
  type: 'setShowHostDirectories';
  enabled: boolean;
}

export interface SaveDirectory {
  type: 'saveDirectory';
  name: string;
  path: string;
  previousPath?: string;
}

export interface RemoveDirectory {
  type: 'removeDirectory';
  path: string;
}

export interface RequestDirectorySuggestions {
  type: 'requestDirectorySuggestions';
}

export interface RequestDiagnostics {
  type: 'requestDiagnostics';
}

export interface SetPokemonTheme {
  type: 'setPokemonTheme';
  enabled: boolean;
}

export interface OpenExternal {
  type: 'openExternal';
  url: string;
}

export interface RequestSessionDetail {
  type: 'requestSessionDetail';
  id: number;
}

export interface SendSessionMessage {
  type: 'sendSessionMessage';
  id: number;
  text: string;
}

export interface StopSession {
  type: 'stopSession';
  id: number;
}

export interface RequestConductorSessions {
  type: 'requestConductorSessions';
}

export interface SetConductorScope {
  type: 'setConductorScope';
  scope: ConductorScope;
}

export interface SetSessionHidden {
  type: 'setSessionHidden';
  sessionId: string;
  hidden: boolean;
}

export interface SetSessionPinned {
  type: 'setSessionPinned';
  sessionId: string;
  pinned: boolean;
}

export interface ArchiveSession {
  type: 'archiveSession';
  sessionId: string;
}

export interface RestoreSession {
  type: 'restoreSession';
  sessionId: string;
}

export interface RequestSessionHistory {
  type: 'requestSessionHistory';
  id: number;
  before?: string;
}

export interface RequestMusicLibrary {
  type: 'requestMusicLibrary';
}

export interface MusicCommand {
  type: 'musicCommand';
  action: MusicCommandAction;
  source: MusicSourceId;
  stationId?: string;
  uri?: string;
  volume?: number;
  shuffle?: boolean;
}
