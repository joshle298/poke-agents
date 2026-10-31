# Poke Agents — Compressed Reference

Pixel art office where AI coding sessions become animated characters. **Poke Agents** is inspired by and based on [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) (Pablo De Lucca, MIT): by default it shows **Conductor cloud sessions as Pokémon** (a `StreamProvider` polls Conductor's public API), and `--claude` adds upstream's Claude Code tracking. It ships as the **`poke-agents` standalone CLI**, installed from GitHub; the same tree still builds upstream's **VS Code extension** (Claude Code only, upstream characters). Poke Agents' own architecture is in "Conductor provider" and "Pokémon theme" below; everything else comes from Pixel Agents and still applies.

**Product principle: Poke Agents is a visualizer for Conductor.** All coding happens in Conductor with the user's Conductor configuration. In its default and desktop modes Poke Agents never runs agents or starts sessions, never edits repositories, and never stores or overrides Conductor settings (models, environment, repositories, API keys). User actions only ask Conductor's API to act (send a message, stop, archive, unarchive), on an explicit click in a tokened office. Hide, pin, scope, seats and Pokémon are Poke Agents' own view state. The upstream `--claude` mode (local terminal, hooks) stays opt-in and is never turned on by `npm start`. Reject features that break this (a "new session" flow was deferred for that reason) unless the owner asks for them.

`CONTEXT.md` is the canonical glossary — read it for what terms like Agent, Sub-agent, Teammate, Lead, Adopt, or Headless agent mean here, and use its vocabulary in code, comments, and docs.

## Architecture

Strict layering: `core/` depends on nothing; `server/` depends only on `core/`; `webview-ui/` depends only on `core/`; `adapters/vscode/` depends on `core/` and `server/`; `desktop/` (the Mac app) depends on `core/` and `server/`. The standalone CLI never imports `adapters/vscode/` and vice versa.

```
core/                                Protocol + interface definitions (zero runtime side effects)
  asyncapi.yaml                      AsyncAPI 3.0 contract — single source of truth
  src/
    messages.ts                      AUTO-GENERATED discriminated unions (do not edit)
    schemas.ts                       AgentMeta, SpriteData, FurnitureCatalogEntry
    provider.ts                      HookProvider, StreamProvider, AgentEventSink, AgentEvent (the integration boundary)
    teamProvider.ts                  Optional TeamProvider (semantic queries for Lead + Teammates)
    transport.ts                     MessageTransport interface, TransportState
    adapter.ts                       StateAdapter, AssetCache, PersistedAgent, AgentSeat
    terminalAdapter.ts               TerminalAdapter (editor-driven terminal management)
    normalizeProjectPath.ts
    constants.ts

server/                              Lifecycle runtime + Fastify HTTP/WS server
  src/
    providers/hook/claude/           Reference HookProvider — only place that knows Claude specifics
      claude.ts                      normalizeHookEvent for 11 Claude events, formatToolStatus, file fallback
      claudeTeamProvider.ts          TeamProvider: reads ~/.claude/teams/<name>/config.json
      claudeHookInstaller.ts         Consent-gated install/uninstall in ~/.claude/settings.json (abort on unparseable file or non-array hooks.<Event>; one-time .pixel-agents.backup, exclusive-create, no backup ⇒ no write — but skipped when the replaced content is entirely our own install's output, since backing up our own file masquerades as the user's original (`settingsHoldOnlyOurHooks`, compared against makeHookEntry — the WRITER — so a field added to what we write can't silently revive the bug; only `command`/`timeout` may differ, they vary across installs); every write failure THROWS; mode preserved, 0600 on create; re-read verify immediately before rename + retry; hook identity = `/.pixel-agents/hooks/claude-hook.js` suffix anchored at both ends of the command's first token, case-insensitive; `areHooksInstalled` = ANY of our commands on ANY event)
      consentCopy.ts                 Claude's first-run consent disclosure text (scope/data/undo), served through consentDisclosure()
      constants.ts                   Claude hook event names, script path
      hooks/claude-hook.ts           Hook script (CJS+shebang, bundled to dist/hooks/claude-hook.js)
    providers/hook/consentGate.ts    Provider-agnostic consent POLICY: when to ask (hooksConsentRequest per provider) and what an answer means (consentActionFor(choice, {installed, consent}) — see docs/adr/0001)
    providers/hook/consentExecutor.ts Provider-agnostic consent EXECUTION: applyConsentChoice(providerId, choice, ConsentEffects) runs the six actions in one order for both surfaces, and SERIALIZES answers per process across ALL providers
    providers/index.ts               Provider registry (claudeProvider + the hookProviders list the consent gate loops over)
    providers/stream/conductor/      StreamProvider for Conductor cloud sessions (see "Conductor provider")
    pokemon/                         Sprite cache + route, species catalog, species assigner, agentLevel (see "Pokémon theme")
    audio/                           Cry cache + GET /api/pokemon/cry/:dex4, sound pack routes, --no-sounds switch (see "Pokémon theme")
    providers/stream/silentSeed.ts   Optional sink extension: seedSilently(fn) sends every status an adoption causes with silent:true
    music/                           Jukebox server half: Poke Agents Radio (pinned catalog + download cache), music folder scan + /api/music/track, Music/Spotify AppleScripts, saved links (see "Jukebox")
    providers/stream/demo/           --demo: a StreamProvider (id 'conductor') playing a scripted story of synthetic sessions (see "Demo mode")
    streamAgentDriver.ts             AgentEventSink for stream providers: drives the store with the hook path's broadcast shapes
    streamSessionMessages.ts         Client messages for stream sessions (Pokédex detail and history pages, session actions, scope, openExternal, setPokemonTheme)
    agentTransitions.ts              markAgentWaiting / endAgentTurn, shared by HookEventHandler and the stream driver
    agentMessages.ts                 agentCreatedMessage / agentDetailsMessage, one builder for standalone, VS Code and replays
    openAppWindow.ts                 --open: a one-time launch URL in a Chromium app window; the system opener for deep links (injectable exec)
    launchCodes.ts                   One-time --open codes: POST /api/launch-code (Bearer) mints, GET /launch/:code redeems once and redirects to /?token=
    agentRuntime.ts                  Lifecycle core: timers, scanners, HookEventHandler, SessionRouter, DismissalTracker
    agentStateStore.ts               EventEmitter-backed single source of truth (typed mutations + events)
    sessionRouter.ts                 session_id → agent_id mapping, event buffering, pending external sessions
    dismissalTracker.ts              Unified dismissal state (replaces four legacy globals)
    hookEventHandler.ts              Dispatches normalized AgentEvent into runtime
    httpServer.ts                    Fastify: POST /api/hooks/:providerId, GET /api/health, GET /ws, launch codes, sprites and the SPA (standalone)
    clientMessageHandler.ts          Single dispatch point for ClientMessage from webview
    server.ts                        Top-level composition
    cli.ts                           poke-agents entry (npm bin): flags, banner, --open, signals
    standalone.ts                    startStandalone(): the one start path for the CLI and the Mac app (assets, store, runtime, server start or reuse, the Conductor lock and poller, Claude)
    fileStateAdapter.ts              Namespaced ~/.pixel-agents/ persistence
    configPersistence.ts             { vscode, standalone, externalAssetDirectories, hooksConsent: {providerId: granted|declined}, hooksEnabled: {providerId: boolean} }
    layoutPersistence.ts             ~/.pixel-agents/layout.json with atomic tmp+rename
    fileWatcher.ts                   Hybrid fs.watch + 500ms polling, JSONL line buffering, /clear detection
    transcriptParser.ts              JSONL parsing for heuristic / file-fallback mode
    timerManager.ts                  Waiting / permission timers
    assetLoader.ts                   PNG → SpriteData via pngjs
    teamUtils.ts                     isInlineTeammateOf, getInlineTeammates, hasInlineTeammates
    types.ts                         ServerAgentState
    constants.ts                     All timing/scanning constants
  __tests__/                         Vitest files (60)
  manual-hook-events.http            Manual hook testing helper (REST-Client format)

desktop/                             Mac app (Electron). Own package.json + lockfile, NOT an npm workspace (root installs never fetch Electron)
  src/                               Pure helpers, no Electron (root check-types via tsconfig.helpers.json; `npm run test:desktop`)
    attention.ts                     Which sessions need you; notice ids, withdrawals, grace/quiet/dedupe, rate limit + overflow summary; Dock badge count
    officeFeed.ts                    Office messages: in-process store events, or a tokenless read-only /ws to a reused server
    windowState.ts                   Saved window frame → placement on the current displays
    navigation.ts                    Window navigation verdict: office origin / default browser / Conductor deep link / block
    menu.ts                          App menu template (File → Close Window, Settings…, Reconnect, Help); Electron-free
    reconnect.ts                     Reconnect outcome from conductorStatus, and the app's dialog text
    args.ts                          --smoke, --smoke-out, --smoke-reconnect and --demo (POKE_AGENTS_DEMO=1): the demo office instead of Conductor
    species.ts, constants.ts
  src/electron/                      main.ts (lifecycle, window, office start/reuse/takeover, IPC), preload.ts (office bridge), notifier.ts, smoke.ts
  scripts/build.mjs                  esbuild main → dist/main.js (server + Fastify bundled; electron external), preload → dist/preload.js, copies dist/{webview,assets} → dist/office
  scripts/dist-mac.mjs               electron-builder --mac for this Mac's arch (--all: arm64 + x64)
  scripts/verify-bundle.cjs          electron-builder afterPack: app.asar = main.js + preload.js + package.json only; no node_modules, PTY or hook script
  electron-builder.yml               mac dir + zip, ad hoc signature (identity "-"), no hardened runtime or notarization; one copyright line (= COPYRIGHT); NSAppleEventsUsageDescription (the Jukebox)
  resources/icon.{icns,png}          Generated by scripts/generate-icons.mjs
  test/                              node:test through tsx
adapters/vscode/                     VS Code surface — composes core + server
  extension.ts                       activate() / deactivate()
  PixelAgentsViewProvider.ts         WebviewViewProvider, thin bridge to AgentRuntime
  agentManager.ts                    Terminal lifecycle (claude --session-id <uuid>), restore, persist
  vscodeTerminalAdapter.ts           TerminalAdapter implementation
  uninstall.ts                       vscode:uninstall hook — removes hook entries + factory-resets hooks config after extension removal
  migrateVsCodeState.ts              One-time legacy state migration (verify-before-clear)
  constants.ts                       VS Code IDs, command names, key names

webview-ui/                          React 19 + Canvas UI (depends only on core/)
  src/
    transport/
      index.ts                       createTransport() — single runtime branching point
      postMessageTransport.ts        VS Code mode (acquireVsCodeApi)
      webSocketTransport.ts          Standalone mode (exponential backoff, send queue; stops on a 4003 "forbidden host" close)
      types.ts                       Re-exports MessageTransport from core
    runtime.ts                       isBrowserRuntime detection
    browserMock.ts                   Standalone-browser asset fetch + message injection
    testHooks.ts                     window globals exposed for e2e (officeState, helpers)
    main.tsx                         React entry (StrictMode + createRoot)
    App.tsx                          Composition root (hooks + components + EditActionBar)
    constants.ts                     Webview magic numbers/strings
    notificationSound.ts             Web Audio API chime; owns the shared AudioContext (sharedAudioContext, unlockAudio)
    audio/                           Pokémon sounds: pure soundPolicy (SoundDirector) + soundLimiter (rate, cooldowns, CryQueue),
                                     soundController (switch/toggle/unlock gates), chimeHandoff, sfxRecipes (data) + synth,
                                     audioEngine, soundPrefs, soundPack, usePokemonSounds, SoundSettings
    changelogData.ts                 Changelog modal content; versionNotice (no "Updated to" notice on a first run)
    escapeStack.ts                   The one Escape stack: the topmost open surface closes (capture phase), nothing beneath it
    conductor/                       Conductor chrome: DOM-free conductorStore (+ useConductor), useConductorFeed, actions,
                                     pure party/format/sessionsView rules, per-device preferences
      chat.ts                        Chat thread rules: merge detail + history pages by key, tool grouping, reply-box keys (IME-safe)
      chatText.ts                    plainText: markdown links/images as text, %XX decoded, no @ marker (never HTML)
      visibleInterval.ts             An interval that pauses while the page is hidden (the Pokédex refresh)
    music/                           Jukebox: musicStore, folderPlayer (radio + folder music, decks, crossfade), pure queue/mix/duck, panel + pill
    components/                      React UI (toolbars, modals, settings)
      BottomToolbar.tsx, ZoomControls.tsx, SettingsModal.tsx, ChangelogModal.tsx,
      Tooltip.tsx, DebugView.tsx, ui/Button.tsx, ...
      SessionPanel.tsx               The Pokédex: Overview (facts, actions, recent lines, "Answer in Chat" for a pending question) and Chat tabs
      PokedexChat.tsx                Chat tab: sticky-scroll thread, grouped tool lines, peer jumps, Load earlier
      ReplyBox.tsx                   The reply box both tabs share (one send at a time; sending, sent, refused, no answer)
      CreditsModal.tsx               "About": the visualizer principle, the Pixel Agents credit, sprite artists
      AgentCard.tsx, AgentCardBar.tsx  Agent cards (mug shot + status dot); the right-edge bar on desktop/VS Code
      cardBar.ts                     Pure card-bar rules: cardVariant, mergeOrder, reorderByPointer (Node-tested)
      TerminalDrawer.tsx             Desktop standalone: right-docked panel, cards as tabs
      TerminalPaneStack.tsx          Every agent's TerminalPane mounted, the shown one visible (both shells)
      TerminalPane.tsx               One xterm bound to one agent's PTY
      MobileAgentBar.tsx             Mobile bottom card scroller (+ launch card, long-press reorder)
      MobileTerminalPage.tsx         Mobile terminal page (a TerminalPaneStack)
      MobileKeyBar.tsx               Accessory keys above the software keyboard (esc, shift+tab, trackpad, paste)
    mobile/                          The phone shell (standalone only, see "Mobile shell")
      MobileShell.tsx                Sliding office/terminal track + card bar + key bar
      useMobileShell.ts              Page state and navigation rules (toggle, card tap, launch-then-slide)
      edgeSwipe.ts                   Edge-swipe state machine (pure reducer, Node-runner tested)
      keyboardViewport.ts            Software-keyboard decision: open vs per-width baseline, clamp only when the visual viewport is shorter (pure)
      useEdgeSwipe.ts                DOM adapter for the reducer (capture listeners, detached-target rescue)
    touch/
      touchPrimitives.ts             findTouch (track one finger by id) + withinTapSlop (the one tap metric)
    terminal/                        Standalone terminal (xterm) support
      terminalClient.ts              /terminal/:agentId socket (reconnect, replay)
      terminalLinks.ts               Safe link opener + urlAtCell (one URL pattern for clicks and taps)
      touchGesture.ts                Terminal touch state machine: scroll, flick, tap, long-press select, handles (pure reducer)
      touchInput.ts                  DOM adapter: listeners, flick rAF, long-press timer, detached-target rescue
      selectionMath.ts               Word expansion, range ordering, handle clamping (pure)
      selectionOverlay.ts            Copy pill (Copy | Copy as text) + selection handles (DOM; styled in index.css)
      clipboard.ts                   The one clipboard write/read: Clipboard API on secure origins; plain http falls back to a copy event (write) / a native prompt (paste)
      flowCopy.ts                    terminalCopyText: verbatim by default; opt-in re-flow of Claude Code's soft wraps (pure)
      clipboardKeys.ts               Clipboard chords (Ctrl+C/Ctrl+Shift+C copy, Alt+C copy as text, Ctrl+V paste) + OSC 52 decode (pure)
      terminalDom.ts                 xterm screen geometry + isTypingInTerminal
    hooks/
      useExtensionMessages.ts        Message handler — translates ServerMessage into OfficeState mutations
      useEditorActions.ts            Editor state + callbacks
      useFurnitureColorActions.ts    Furniture colour sliders + colour-only eyedropper
      useEditorKeyboard.ts           Keyboard shortcuts (R, T, Esc, Ctrl+Z/Y)
      useEscapeLayer.ts              Registers a surface on the Escape stack while it is open
      usePokedexRefresh.ts           requestSessionDetail on open and every 5 s while the Pokédex is open and the page visible
      introTourState.ts              Intro tour wire-state machine (pure reducer, Node-runner tested)
      useIntroTour.ts                Wires the reducer to React + transport (snapshot, verdict, choices)
      useTerminalDrawer.ts           Terminal-pane model for both shells: active/shown pane, socket status, card lookups
      useIsMobile.ts                 Mobile breakpoint — always false in the VS Code webview
      useKeyboardViewport.ts         Samples the viewport: keyboard open (key bar) + iOS shell clamp height
    office/
      types.ts                       OfficeLayout, Character, etc. + re-exports constants
      toolUtils.ts                   STATUS_TO_TOOL mapping, extractToolName (DOM-free; defaultZoom lives in useEditorActions)
      projection.ts                  World→screen math shared by renderer + DOM overlays (mapOffset, overlayProjection)
      asleep.ts                      The one asleep rule (done or idle, no activity for SLEEP_AFTER_MS) the office and party share
      colorize.ts                    Colorize (grayscale→HSL) + Adjust (HSL shift)
      floorTiles.ts                  Floor sprite storage + colorized cache (+ tall-grass foreground halves)
      floorForeground.ts             Tall grass: alpha-254 floor pixels drawn again over whoever stands in them (pure)
      wallTiles.ts                   Wall auto-tile: 16 bitmask sprites
      sprites/
        spriteData.ts                Pixel data (characters, furniture, tiles, bubbles)
        spriteCache.ts               SpriteData → offscreen canvas, per-zoom WeakMap
      editor/
        editorActions.ts             Pure layout ops
        editorState.ts               Imperative state (tools, ghost, selection, undo/redo + undo session, drag, placing)
        editorRenderState.ts         buildEditorRenderState: ghosts + selection for the renderer (pure)
        EditorToolbar.tsx
      layout/
        furnitureCatalog.ts          Dynamic catalog from loaded assets
        layoutSerializer.ts          OfficeLayout ↔ runtime (tileMap, furniture, seats)
        tileMap.ts                   Walkability, BFS pathfinding
        areaRoles.ts                 Meadow / Center tiles from Areas with a `role` (pure)
        bundledLayouts.ts            The Templates panel's layouts (Pokémon Town, Classic Office), lazy chunks
      engine/
        characters.ts                Character FSM (idle/walk/type) + wander AI
        officeState.ts               Game world (layout, characters, seats, selection, subagents, consent greeter)
        gameLoop.ts                  rAF loop with delta-time cap (0.1 s)
        renderer.ts                  Canvas: tiles, z-sorted entities, overlays, edit UI
        matrixEffect.ts              Spawn/despawn digital rain (drawing only)
        matrixEffectState.ts         Effect state: startMatrixEffect/advanceMatrixEffect (DOM-free)
        pokemonAnim.ts               Pure PMD anim choice (PMD_ROW, pmdFrameIndex, choosePokemonAnim, one-shots)
        pokemonCharacter.ts          Pokémon state on a Character (identity, capsule placeholder, geometry, faint/sleep)
        pokemonRender.ts             Renderer branch for Pokémon (frames, outline, faint tint)
        pokemonTheme.ts              Theme flag as module state (render loop + OfficeState read it)
        capsuleEffect.ts             Capsule throw/open/recall behind the matrixEffect field
        frameCanvas.ts               Lazily built, cached derived frame canvases (outline, silhouette, tint)
        connectionsRender.ts         Link lines (floor pass) and message projectiles
        teammatePlacement.ts         Where a teammate sits (stream children cluster only by a small Lead)
        townBehavior.ts              Pokémon Town: where inactive characters go (Meadow, Center, stay) and the step there (pure)
      components/
        OfficeCanvas.tsx             Canvas, resize, DPR, mouse hit-testing, drag-to-move
        useCanvasTouchGestures.ts    Touch pan / pinch zoom / tap on the canvas
        ToolOverlay.tsx              Activity label + speech bubbles (DOM, above the labels) per character; themed label + HP bar
        pokemonOverlay.ts            Themed label, HP fraction and colour helpers
      sprites/pokemonSprites.ts      Species store fed by pokemonSpeciesLoaded (DOM-free; injectable sheet loader); sweepPokemonSheets closes sheets unused for 5 min
      sprites/pokemonSheetLoader.ts  Browser loader: fetch → blob → createImageBitmap (same-origin only)
      chimePolicy.ts                 Which status changes chime (restricted policy for stream agents)
      showConnections.ts             Local "Show connections" preference (localStorage, useSyncExternalStore)

e2e/                                 Playwright suite (real VS Code + mock-claude scenarios)
  playwright.config.ts
  global-setup.ts
  fixtures/
    pixel-agents.ts                  VS Code fixture: launch Electron, wait for panel
    standalone.ts                    Standalone CLI fixture: spawn server + browser page
    mock-claude, mock-claude.cmd     Bash + cmd wrapper invoked instead of real claude
    mock-claude-runner.cjs           Scenario runner: appendJsonl, emitHook, holdOpen
  helpers/
    launch.ts                        Electron app + isolated HOME/workspace
    mock-claude.ts                   claudeScenario() builder
    office.ts                        Overlay locators + assertions
    webview.ts                       Settings/modal helpers
    hooks.ts                         Hook server lifecycle helpers
    standalone.ts                    Standalone server + WebSocket browser helpers
    internal-agent.ts                spawnInternalAgentAndWait
    lifecycle.ts                     Reusable scenario fragments
    team.ts                          Team config seeding + teammate helpers
    allure-labels.ts                 @area:<tag> → Allure epic
  tests/
    claude/hooks-on/                 basic.spec.ts, lifecycle.spec.ts, teams.spec.ts
    claude/hooks-off/                lifecycle.spec.ts, matrix.spec.ts
    standalone/                      hooks.spec.ts
  README.md                          Auto-generated test inventory (regen via npm run e2e:inventory)

scripts/
  generate-messages.ts               AsyncAPI → core/src/messages.ts via Modelina (with CI drift check)
  prepare.mjs                        npm prepare: husky in a git checkout; builds dist/ when missing or built from another commit, with first-run messages
  docs-contract.test.mjs             Docs drift checks: README flags/env vars/defaults, protocol counts in CLAUDE.md, product wording
  npm-package-contract.mjs           Package identity (@joshle298/poke-agents, bin poke-agents) + tarball file allowlist
  verify-npm-package.mjs             Packs, installs and smoke-runs the tarball (--no-conductor --claude, sprites off)
  generate-pokemon-catalog.mjs       Regenerates server/src/pokemon/speciesCatalog.ts from a species.json
  generate-icons.mjs                 Draws the app icon in code (pngjs) and writes every icon file: .icns, favicon.ico, PWA/touch icons, icon.png (test fails on drift)
  generate-world-assets.mjs          Draws the Pokémon Town's floors, path carpet, furniture and layout in code (world/*.mjs)
  run-e2e.mjs                        Playwright wrapper (run-id namespacing, video attach flags)
  generate-e2e-inventory.mjs         Splices test list into e2e/README.md (CI drift check)
  build-allure-report.mjs            Combine e2e+server+webview Allure results
  assemble-vercel-output.mjs         Stage /reports/allure/ for Vercel deploy
  asset-manager.html                 Unified furniture editor (positions + metadata)
  jsonl-viewer.html                  Standalone JSONL transcript inspector
  wall-tile-editor.html              Wall sprite editor

core/                                npm workspace (no separate package; root manages)
server/                              npm workspace
webview-ui/                          npm workspace
```

## Distribution

- **npm package `@joshle298/poke-agents`** (bin `poke-agents`), **not published**. Users install from GitHub: `git clone … && npm ci && npm start` (`start` = `node dist/cli.js --open`; `npm run demo` = `node dist/cli.js --demo --open`), or `npx github:joshle298/poke-agents --open` (npm ≥ 12 refuses git specs unless given `--allow-git=all`). `dist/` is gitignored, so `prepare` (`scripts/prepare.mjs`) builds it (`npm run build:app`, about 5 s) when it is missing — always the case for a git-dependency install — or was built from another commit (stamp `dist/.build-commit`); `POKE_AGENTS_SKIP_BUILD=1` skips it (CI builds explicitly). It prints what it builds and, after the build, the time and `npm start` as the next step (npm hides this output for git-dependency installs, so the first `npx` run is silent for about 20 s). When a build is needed but the build tools (`BUILD_TOOLS`: esbuild, typescript, vite) are missing (`--omit=dev`, `NODE_ENV=production`), it prints `npm ci --include=dev` and fails the install, or keeps a stale `dist/` with a warning. A failed build ends with a two-line hint, never a stack trace from `prepare.mjs`. Never document `npx poke-agents`: that unscoped npm name is an unrelated package.
- **Mac app** (`desktop/`) — `npm run app:mac` builds `desktop/release/mac-arm64/Poke Agents.app`, `desktop/release/mac/Poke Agents.app` and zips; `npm run app:dev` runs it unpackaged. Not distributed: built on the owner's Mac (ad hoc signed). See "The Mac app" below.
- **VS Code extension** — still builds from this tree (`vscode:prepublish`), with upstream's IDs (`pablodelucca.pixel-agents`, `pixel-agents.*`) and upstream characters. Poke Agents does not publish it.

`package.json:files` allowlist controls the npm tarball: `dist/cli.js`, `dist/extension.js`, `dist/hooks/claude-hook.js`, `dist/uninstall.js`, `dist/assets/`, `dist/webview/`, `CHANGELOG.md`, `LICENSE`, `icon.png`. `scripts/npm-package-contract.mjs` pins the required and forbidden paths (no source maps, no `server/`/`webview-ui/` sources) and the package identity; `npm run verify:npm-package` installs the packed tarball and smoke-runs it. Nothing Pokémon may ever live under `webview-ui/public/assets/` (copied into `dist/assets/`).

## Communication Flow

Hub-and-spoke. The server is the single aggregation point for all agent activity, regardless of source.

```
Hook scripts ─POST /api/hooks/:providerId─┐
                                          ├─→ HookProvider.normalizeHookEvent()
JSONL transcripts ─FileWatcher─→ TranscriptParser ┤
                                                   ↓
                                              AgentEvent (canonical)
                                                   ↓
                                              AgentRuntime (dispatch on .kind)
                                                   ↓
                                           AgentStateStore (mutate) ←── StreamAgentDriver (AgentEventSink)
                                                   ↓                                 ↑ emit / upsert / link
                                              StoreEvents → broadcast          StreamProvider ←─poll─ Conductor API
                                                   ↓
                          PostMessageTransport ──┤├── WebSocketTransport
                                 (VS Code)      (standalone browser)
```

The VS Code adapter wires `PostMessageTransport` against `acquireVsCodeApi()`. The standalone CLI exposes the same protocol over WebSocket at `/ws` with the webview SPA served from the same Fastify instance. **The protocol shape is identical; only the wire differs.**

Adding a new CLI integration is one subdirectory under `server/src/providers/hook/<id>/`: provider, optional `TeamProvider`, installer, hook scripts. Zero changes to the runtime, the UI, or any existing provider. A source with no hooks to push (a remote API) is a `StreamProvider` under `server/src/providers/stream/<id>/` that polls and pushes into an `AgentEventSink`.

## AsyncAPI Protocol Contract

`core/asyncapi.yaml` is the contract. Pinned to **3.0.0** because `@asyncapi/modelina@5.10.1` declares `supportedVersions: ['3.0.0']` only; bumping to 3.1.0 produces `export type Root = any`. Revisit when Modelina ships 3.1.0 support.

- **54 ServerMessage variants** (server → client): agent lifecycle, agent activity, sub-agent activity, team + context usage, assets, access (`officeAccess` — sent first on `webviewReady`; `readOnly` hides every control a read-only office would only have refused), settings (`bypassPermissionsUpdated` — the skip-permissions posture, broadcast to every office on change because every launch reads it) + directories (`directoriesLoaded`, `directorySaved` — a save's ack to its sender, carrying the entry as stored, whose name keys the Area mapping; `directoryRejected`, `directorySuggestions`), terminal, diagnostics, and Poke Agents' Conductor and Pokémon messages (`agentDetails`, `agentLinks`, `agentMessage`, `agentNotice`, `sessionDetail` — with `question`, a `SessionQuestion` the session waits on — `sessionHistory`, `conductorStatus`, `conductorSessions`, `conductorActionResult`, `pokemonSpeciesLoaded`, `pokemonSpeciesFailed`, `pokemonThemeUpdated`), and the Jukebox's `musicLibrary`, `musicState` and `musicActionResult`.
- **41 ClientMessage variants** (client → server): lifecycle (`webviewReady`, `launchAgent`, `focusAgent`, `closeAgent`), layout (`saveAgentSeats`, `saveLayout`, `exportLayout`, `importLayout`), settings (`setSoundEnabled`, `setHooksEnabled`, `setWatchAllSessions`, `setAlwaysShowLabels`, `setHooksInfoShown`, `setLastSeenVersion`, `setBypassPermissions`, `setShowHostDirectories` — whether the host's own Directories are listed, off by default; only the list is gated, launches still name agents after them), directories (`saveDirectory`, `removeDirectory`, `requestDirectorySuggestions`), terminal, discovery + assets, diagnostics, and Poke Agents' session actions (`setPokemonTheme`, `openExternal`, `requestSessionDetail`, `requestSessionHistory`, `sendSessionMessage`, `stopSession`, `archiveSession`, `restoreSession`, `requestConductorSessions`, `setConductorScope`, `setSessionHidden`, `setSessionPinned`) and the Jukebox (`requestMusicLibrary`, `musicCommand`) — every one privileged, so a read-only office can't send them.

Both unions use `oneOf` with `discriminator: type`. Every concrete message sets `additionalProperties: false`.

`core/src/messages.ts` is generated by `scripts/generate-messages.ts` invoking `@asyncapi/modelina` with custom constraints (`propertyKey` preserves `type`/`status` field names; `constant` inlines `const` literals). The file has an auto-generation banner. **CI runs `asyncapi:generate` then `git diff --exit-code core/src/messages.ts` — any non-empty diff fails the build.**

## Transport Abstraction

```typescript
export interface MessageTransport {
  send(msg: ClientMessage): void;
  onMessage(handler: (msg: ServerMessage) => void): () => void;
  readonly ready: Promise<void>;
  readonly state: TransportState;
  onStateChange(handler: (state: TransportState) => void): () => void;
  dispose(): void;
}
export type TransportState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
```

`PostMessageTransport` reports `connected` for its entire lifetime. `WebSocketTransport` reconnects with exponential backoff (250 ms, 500 ms, 1 s, 2 s, 4 s, capped) and queues sends while disconnected.

`createTransport()` in `webview-ui/src/transport/index.ts` is the **only branching point** in the UI codebase. Everything downstream uses the `MessageTransport` interface and never knows which transport is active.

## Provider Abstraction

`HookProvider` (`core/src/provider.ts`) is the integration boundary. Today only Claude Code is implemented; the Claude provider supports every transcript/hook format up to **Claude Code v2.1.220** (current as of 2026-07-30 — Task-era `agent_progress` records, explicit and implicit teams, background-by-default Agent spawns, sidecar-backed background agents). Newer CLI releases may add formats that need provider updates. The interface:

- **Required**: `normalizeHookEvent(raw)` → `{ sessionId, event: AgentEvent } | null`; `installHooks` / `uninstallHooks` / `areHooksInstalled`; `formatToolStatus`; `permissionExemptTools`, `subagentToolNames`, `readingTools` sets.
- **Optional file fallback**: `getSessionDirs(workspace)`, `getAllSessionRoots()`, `sessionFilePattern`, `parseTranscriptLine(line)`, `buildLaunchCommand(sessionId, cwd, opts)`. Used when hooks aren't installed.
- **Optional team extension**: `team?: TeamProvider` for Lead + Teammates support.

`AgentEvent.kind` values: `toolStart`, `toolEnd`, `turnEnd`, `subagentStart`, `subagentEnd`, `subagentTurnEnd`, `progress`, `permissionRequest`, `sessionStart`, `sessionEnd`, plus the stream-only `turnStart`, `awaitingInput`, `permissionClear`, `contextUsage`, `notice` (and `turnEnd.outcome` `done | error | aborted` with `errorMessage`). The runtime dispatches on `kind`, never on CLI-specific tool names.

### StreamProvider + StreamAgentDriver (sources without hooks)

`StreamProvider` (`core/src/provider.ts`, `kind: 'stream'`) is the second integration type: the provider owns its own polling and pushes into an `AgentEventSink` given to `start(sink)`. `start()` resolves after the first discovery pass (or a definitive auth failure) and never rejects; `stop()` ends polling. Like a HookProvider it declares `formatToolStatus`, `permissionExemptTools`, `subagentToolNames`, `readingTools` and optionally `contextWindowForModel`. Optional hooks back the UI actions: `onDismiss`, `setSessionHidden`, `setSessionPinned`, `getScope`/`setScope`, `listSessions`, `getSessionDetail` (a `StreamSessionDetail`: prompt, entries, and the open `question` if any), `getSessionHistory(sessionId, before?)` (one older page for the chat view: entries oldest first, an opaque `before` cursor and `hasMore`), `sendMessage`, `stopSession`, `archiveSession`, `restoreSession`, `setFocus`.

The sink: `upsertSession(StreamSessionInfo)` (create or update an agent, with `details` for the Pokédex), `emit(sessionId, AgentEvent)`, `link(AgentLinkEvent)` (`spawned | messaged | watched`, `live` only for fresh steady-state items), `removeSession`, `setStatus` (→ `conductorStatus`) and `sessionsChanged` (→ `conductorSessions`).

`AgentRuntime.attachStreamProvider(provider)` returns a `StreamAgentDriver` (`server/src/streamAgentDriver.ts`), the sink implementation; `dispose()` disposes drivers. The driver mirrors the broadcasts the hook and transcript paths already send, so the webview needs no provider-specific code:

- **Agents**: `isExternal`, `hooksOnly`, `hookDelivered`, `jsonlFile: ''`, `projectDir: ''`, `providerId: 'conductor'`, `sessionId: 'conductor:<uuid>'`, `directoryName` = repo short name, `label` = session name else `#<number> <workspace>`. Agent ids and Pokémon (`pokemonLine`, `species`, `shiny`) are remembered per `conductor:<uuid>` in `<namespace>-state.json` under `streamAgents` (`StreamAgentMemory`, implemented by `FileStateAdapter`, capped at 1000), so a session keeps its seat and species across restarts; attaching bumps `store.nextAgentId` past every remembered id. `agentCreated` carries `providerId`, `label`, `species`, `shiny`, `level` and `seatId`; `agentDetails` follows on creation, on every change and on reconnect.
- **Events**: `turnStart` → `agentStatus active`; tools tracked as the transcript path does (`toolEnd` delayed `TOOL_DONE_DELAY_MS`); `permissionRequest/Clear` → `agentToolPermission(Clear)`; `awaitingInput` → `agentStatus waiting awaitingInput:true` (clears nothing); `turnEnd` → `markAgentWaiting`, and `outcome: 'error'` → `agentStatus error` with `errorMessage` (≤ 200 chars) until the next `turnStart`; `contextUsage` → `reportContextUsage`; `notice` → `agentNotice`. Identical statuses are never re-broadcast; seeding and reconnect resends are `silent`.
- **Runtime guards**: the stale check skips agents without a `jsonlFile`; `/clear` detection needs `isExternal && !hooksOnly`; permission and waiting timers return early for `hooksOnly` agents; `providerCapabilities` sends the union of active providers' tool sets plus `activeProviders`.
- **Links and teams**: links keyed `(from, to, kind)` with `count`, `lastAt`, `preview`; `agentLinks` snapshots (both ends in the office) debounced 500 ms; live `agentMessage` coalesced to one per pair per 2 s and 6/s overall. A session with an outgoing `spawned` link is a Lead (`isTeamLead`, `promoteToOrchestrator`); its targets get `leadAgentId`, `agentName`, `teamUsesTmux: true`, never `teamName`. Removing a Lead clears its children's `leadAgentId`; closing a Conductor agent hides it (`onDismiss`) and never removes its children.

### TeamProvider (Lead + Teammates)

Optional extension for CLIs that support team workflows (Claude Agent Teams today). Semantic queries (`discoverTeammates`, `getTeamMembers`, `getTeamMetadataForSession`, `extractTeammateNameFromEvent`, `isTeammateSpawnCall`) — providers choose their own storage strategy.

Four teammate modes:

| Mode                            | Trigger                                          | Detection                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Basic subagent (teams OFF)      | `Task(...)` or `Agent(run_in_background: false)` | `subagentStart` with team gate not matched, or JSONL `agent_progress`                                                                                                                                                                                                                                                                                                                   |
| Inline teammate (teams ON)      | `Agent(run_in_background: true)` in-process      | `onTeammateDetected` → `discoverTeammates(projectDir, leadSessionId)`                                                                                                                                                                                                                                                                                                                   |
| Session teammate (teams + tmux) | `Agent(run_in_background: true)` in tmux pane    | Own session, own hooks, routes through normal flow                                                                                                                                                                                                                                                                                                                                      |
| Implicit-team agent (Claude 5)  | `Agent(...)` — background by default, NO flag    | Lead-side: spawn tool_result `agent_id: <name>@<team>` → `extractTeammateSpawnFromToolResult` sets lead `teamName`; teammate = own top-level UUID session tagged `teamName`/`agentName` on every record, discovered by `discoverTeammates(projectDir, leadSessionId, teamName)` and fast-attached in `onExternalSessionDetected` (bypasses the Watch All gate when the lead is tracked) |

Newer harnesses (Claude 5) never tag the LEAD's records with team metadata and never write `agent_progress`/`queue-operation` records for these spawns — the spawn tool_result and the teammate's own session (own JSONL, own hooks) are the only signals. The implicit team writes `~/.claude/teams/session-<8hex>/config.json` (its `leadSessionId` matches no transcript on disk — don't link by it). Own-session teammates are registered with the SessionRouter (`setTeammateRegisterCallback`) so their hooks route directly to them.

**Team generations on resume (last-wins latch)**: every CLI run of a session mints a FRESH implicit team, so a resumed lead's transcript carries spawn tool_results from several `session-<8hex>` generations. A tag-less lead re-latches to the newest spawn's team (`setTeamSwitchCallback` removes the defunct team's teammates); tag-derived identity (`teamNameFromTags`, set by the record-tags branch) is authoritative and never overwritten by spawn results. `linkTeammates` never badges a named teammate as LEAD — if only teammates are tracked, linking waits until the real lead is detected (prevents a phantom LEAD character when a teammate session is adopted before/without its lead). Restore drops `isTeamLead` from persisted agents that carry an `agentName`.

**Background spawns without a CLI team (sidecar-backed)**: `Agent(...)` spawns that never register a team take the async path — result "Async agent launched successfully. agentId: \<hex>" (no team anywhere), transcript + sidecar under `<projectDir>/<leadSessionId>/subagents/` (sidecar carries `agentType`/`description`/`toolUseId`, plus `name` when the spawn was named), completion via `queue-operation`. `scanForBackgroundAgentFiles` classifies them by the sidecar `name` — the domain model's sole Sub-agent vs Teammate distinction (see CONTEXT.md):

- **Named → Teammate**: its own seated character, `agentName` from the sidecar `name`; the spawner gets `isTeamLead` + an `agentTeamInfo` broadcast (derived team — NO `teamName`, so config polling stays away) and the transient Subtask is ghost-killed via `subagentClear`. The child has `leadAgentId` + `spawnToolUseId`; it's removed on the completion queue-operation or lead sessionEnd (`removeTeammate` must NOT unregister its session — it shares the lead's).
- **Unnamed → Sub-agent**: the Subtask sub-character stays; the spawn's transcript is watched in a **shadow `AgentStateStore`** (`server/src/subagentWatch.ts`, owned by `AgentRuntime`, ids from 1 000 000 up) whose broadcasts are translated onto the main store as `subagentToolStart/Done/Permission` keyed `(leadId, spawnToolUseId)` — live activity on the sub-character, no protocol change. `agentToolsClear` on the shadow agent synthesizes `subagentToolDone` for still-live tools so the sub idles between turns. Never persisted, never announced.

The gate for both: the sidecar `toolUseId` must match a LIVE entry in the lead's `backgroundAgentToolIds` (anti-spurious; no teamName involved). `scanForTeammateFiles` skips sidecars carrying a live `toolUseId` so it can't race the classification. The lead's `backgroundAgentToolIds` are persisted (children never are — they're derived state the 1 s scan re-materializes after a reload; restore skips stale entries with `leadAgentId` but no `teamName`). The turn-end background-tool re-sends (transcriptParser, hookEventHandler, timerManager's `clearAgentActivity`) must include `toolName` + `runInBackground` (or the webview can't recreate the Subtask after `agentToolsClear`) and must skip tools whose spawn became a teammate character (`hasPromotedBackgroundAgent`, or a ghost Subtask appears next to it).

Teammate dismissal is driven by team config polling (`getTeamMembers(teamName)` is authoritative; members with `isActive: false` are treated as departed), by the teammate's own `sessionEnd` (own-session teammates), and by `sessionEnd` on the lead.

**Subtle gate (the one that bit us recently)**: in `webview-ui/src/hooks/useExtensionMessages.ts`, `agentToolStart` with `runInBackground=true` only creates a Subtask sub-character when the **parent has no `teamName`**. With a team, `onTeammateDetected` creates the teammate instead (and the gate prevents a ghost sub-agent). Without a team, the teammate path never fires and the basic Subtask sub-character is the only visible representation. The gate's blind spot — a TEAMED lead's unnamed background spawn — is covered by `subagentToolStart` creating the sub-character lazily when it's missing (`addSubagent` is idempotent); the same lazy path recreates subs after a panel reload.

## Conductor Provider

`server/src/providers/stream/conductor/`: `createConductorProvider(opts)` returns the `StreamProvider` with `id: 'conductor'`. Files: `conductor.ts` (the provider), `auth.ts`, `client.ts` (rate budget, errors), `harness.ts`, `normalize/{claude,cursor,codex}.ts` (pure `normalizeItem(item, state) → AgentEvent[]`), `tools.ts` (canonical tool names and status text, wrapping Claude's `formatToolStatus`), `links.ts` (pure link extraction), `poller.ts`, `sessionLog.ts` (Pokédex ring buffer), `state.ts` (`conductor-state.json`), `constants.ts`. Synthetic fixtures with real field names live in `server/__tests__/fixtures/conductor/`; never commit real transcript content.

- **API**: Conductor's public REST API (`https://api.conductor.build`, or `CONDUCTOR_API_URL`), Bearer auth. It needs Conductor Pro and covers **cloud workspaces only**, so local Mac workspaces never appear.
- **Auth**: `CONDUCTOR_API_KEY`, then `CONDUCTOR_API_TOKEN`, then on macOS the Keychain item `conductor auth login` writes: `/usr/bin/security find-generic-password -s com.conductor.cli -a default:<base URL minus trailing /, query and hash> -w`, through `execFile` with no shell. The token is never persisted, logged or put on a command line. No token → status `authRequired`; 401/403 → `unauthorized`; network errors → `unreachable`; 429 → `rateLimited`.
- **Budget**: a token bucket, 120 requests/min by default (`--conductor-budget`). A general 429 halves it once per rate-limit episode (429s that arrive while the pause runs only extend it), honors `retry-after` plus 0-1 s jitter, never drops below 12/min and recovers 10 %/min. Waiting requests are served by priority, and each moves up one level per 15 s of waiting (`PRIORITY_AGING_MS`), never past Hot, so user actions and an open Pokédex still go first but background work can't starve behind a budget that steady polls fill; a per-session `/status` 429 pauses only that session's status checks; 5xx and network errors back off 1, 2, 4, 8 s, capped at 30 s.
- **Discovery**: `/me` once; `GET /v0/workspaces?since=<now − window>&limit=100[&creator=<user id from /me>]` every 15 s, a full list every 5 min; `/v0/workspaces/:id/sessions` when the list is older than 60 s, or when a workspace's `lastActivityAt` advanced (at most once a minute per workspace; `planIntervals` budgets for it); archived sessions (for the PC Box) at most every 2 min per active workspace, for 5 min after a `listSessions`: the 24 most recently active workspaces (`ARCHIVED_LIST_PROMPT_WORKSPACES`; a deposit counts as workspace activity) at discovery priority, ahead of the routine session lists, and the rest in the background. Pinned sessions outside the discovered workspaces are resolved at startup and every 10 min. Scheduled units record their last run when they actually run, with in-flight guards and a retry delay on failure. Never-started sessions (no name, model or messages) are ignored.
- **Tiers**: Focus is a session whose Pokédex or Chat tab is open (see Focus TTL). Focus and Hot poll messages every 2-3 s and `/status` every 30-60 s, and a focused session is never planned slower than Hot. A focused session's linked sessions poll as Hot (not Focus) only when they are in the office, already tailed, and their link carried activity in the last 15 min, at most 4 per focused session; they never start a tail sync. Warm polls messages every 15-30 s; Cold polls nothing until a link or a user action promotes it. A workspace's activity gives each of its other sessions at most one catch-up poll a minute, without promoting them. Intervals stretch to fit the budget.
- **Startup**: the server starts first, then the poller fills the office one session at a time in rank order (pinned, working, then recently active). Per session: `/status`; item #1 (`messages?limit=1`) for `senderSessionId` (the spawn edge and the queued-first-message check), cached in state; then, inside the same onboarding unit, the tail (exponential + binary search on `offset`, or from the persisted cursor) replayed **silently** to rebuild open tools, waiting state, usage and the last texts. A shown session walks in once its message count (its level) and activity time are known, so its first `upsertSession` carries both; if the read fails or takes over 3 min (`LEVEL_WAIT_MAX_MS`), it walks in without them. Adoption runs inside the sink's `seedSilently`, so every status it causes (waiting with `awaitingInput` included) is `silent` and never chimes. A session whose newest user message is queued, or that has no agent items yet, seeds as active. A first run on a machine has no cached cursors, so each tail search costs about 8-15 GETs and the office fills over a minute or two; later runs walk in right after item #1.
- **Activity time**: a session's own activity is its feed, then its persisted time, then `/status` `updatedAt` (for a working session, the time of its last status check, so a turn longer than the window stays in scope). It never borrows its workspace's `lastActivityAt`, which can be hours off for a sibling; unknown activity ranks last, except a workspace's only session, which takes the workspace's time provisionally. Scope, tiers and the Sessions list all use it.
- **Live vs backfill**: link events and notices are `live` only for items received in the last 30 s **and** read by a steady-state tail poll, never by a backfill, re-probe or promotion. A turn that started in the last 30 s is still opened when a catch-up batch or re-read tail contains it, and the driver holds a turn end until the agent has shown working for 2.5 s (`STREAM_TURN_MIN_ACTIVE_MS`; more activity drops the held end, a status change applies it first), so a short turn between two polls still shows a working burst.
- **Reconcile with `/status`**: `idle` while active forces `turnEnd` (for Claude only when no permission is pending); `working` while done forces `turnStart`; `error` or a new `lastErrorAt` forces `turnEnd { outcome: 'error' }`.
- **Context windows**: `claude-*` from Claude's table, `gpt-*` 272,000, otherwise unknown (gauge hidden until usage appears).
- **Scope**, default `{ creator: 'me', activeWithinHours: 6, showIdle: true, maxSessions: 24 }`. `activeWithinHours: 0` ("All") is kept and echoed as 0, and served as the 30-day maximum window (`MAX_ACTIVE_WITHIN_HOURS`), so discovery stays bounded. Cap order: pinned, waiting/permission, working, errored, Leads with visible active children, most recent activity; stable by first-seen order. A shown session stays until it falls 4 places past the cap. At most 12 children per Lead join the office; one already shown stays until it falls 4 places past that cap too, so a large Lead's children don't swap in and out as their activity re-ranks.
- **State file** `~/.pixel-agents/conductor-state.json`: `version: 1`, atomic tmp+rename, mode 0600; `scope` plus `sessions[id] = { hidden?, pinned?, restoredAt?, cursor?, harness?, firstSender?, lastActivityAt?, seenAt? }`. User decisions (scope, hide, pin, a withdrawal) are written within 1 s; cursors and activity times at most every 30 s and on stop. Entries neither hidden nor pinned age out 30 days after anything touched them (`seenAt` is stamped on creation and refreshed daily while a listing shows the session), and at most 2000 are kept. Agent ids, Pokémon and seats live in `standalone-state.json` (`streamAgents`, `seats`), so deleting this file resets scope, hide, pin and cursors, not Pokémon. Never the token.
- **Poller lock** `~/.pixel-agents/conductor.lock` (`{ pid, port }`, 0600, exclusive create): only one office per machine polls Conductor. A second office in another mode (so no shared server) runs without Conductor and names the office that has it; a lock left by a dead process is taken over, and an office only releases its own lock.
- **Focus TTL**: `requestSessionDetail` (sent on Pokédex open, then every 5 s while it stays open and the page is visible) and `requestSessionHistory` call `setFocus([sessionId])`. The poller keeps a separate expiry per session, 10 s (`FOCUS_TTL_MS`) after the last request, so closing the Pokédex (or the window) releases the Focus tier and two offices never overwrite each other's focus.
- **Pokédex log**: per session, a 40-entry ring: the first prompt (≤ 600 chars), user messages, assistant text (≤ 400 chars, whitespace-collapsed), the last 5 tool labels and peer messages. Entries carry `key` (feed item id, `tool:<id>`, `peerIn:<item id>` or `peerOut:<message id>`) and, for tool rows, a canonical `toolName` (`Bash`, `Read`, `Edit`, …, `mcp__<server>__<tool>`). `getSessionDetail` fetches the tail first for a never-tailed session, and returns `question` while the session waits on one: `askUser` (AskUserQuestion's first question, up to 8 option labels of ≤ 120 chars, ` (+N more)` when there are more questions), `plan` (an ExitPlanMode plan under `requires_action`, ≤ 1200 chars, no options) or `notice` (a Codex async question: the agent keeps working, and the question stays until the next user message).
- **History paging**: `requestSessionHistory { id, before? }` → `getSessionHistory` → `sessionHistory { id, entries (oldest first), before?, hasMore, error? }`. Pages of up to 100 feed items come from the messages API on demand at user priority, through the same request budget, never from polling, normalized like the live log with the same keys, so the client merges them with the detail by `key`. The cursor is opaque (`o<offset>` today); malformed cursors and non-session agents are refused. It is privileged like `requestSessionDetail`, because it returns conversation text: a read-only office gets `entries: []`, `hasMore: false` and an error.
- **PC Box**: summaries in `conductorSessions` carry `species`/`shiny` from the live agent, else the stream memory (`streamAgents`), and the sprite route serves any catalog species, so portraits survive a reload. Withdraw persists `restoredAt`: the session is shown like a pinned one for 10 min, then the withdrawal counts as its activity for the scope window, so it stays in the office and the lists even when its last item is older than the window.
- **Writes** come only from explicit UI actions, through privileged client messages, each answered with `conductorActionResult`: `sendMessage` → `POST /v0/sessions/:id/messages` (`messageId` = random UUID), `stopSession` → `/cancel` (Conductor drops queued messages, so the UI confirms), `archiveSession`/`restoreSession` → `/archive`/`/unarchive`. Tests use a fake client: never call a write endpoint from tests or during development. `openExternal` re-validates the URL on the server (scheme `^conductor(-[a-z0-9-]+)?:$`, host `workspace`).

### Standalone modes and the desktop window

- Conductor is on by default (`--no-conductor` turns it off). Claude Code is off unless `--claude`: without it there is no hook install, consent, Claude scanner or PTY, and `activeProviders` says so. `StandaloneAccess` carries both flags (and `demo`), so a running server is reused only in the same mode.
- `--open` (`--app`) opens a one-time launch URL in a Chromium app window (`server/src/openAppWindow.ts`, injectable exec), so the token never reaches the browser's command line (other local users can read a browser's argv). The CLI asks the running server for a code (`POST /api/launch-code` with the Bearer token) and opens `/launch/<code>`; the server redeems it once, under an allowed Host, within 2 min, and redirects to `/?token=…` (`server/src/launchCodes.ts`; used or expired codes get 410, and codes are redacted from the request log). The printed URL is unchanged. macOS: `open -n -b <bundleId> --args --app=<url>` over Chrome, Edge, Brave, Chromium, Vivaldi and Chrome Canary (`--browser <id>` forces one), else `open <url>`; Linux `xdg-open`. A failed launch prints one line (`execFailure`), never the command line or its stderr.
- Only one office per machine polls Conductor (the poller lock above); a second office in another mode says which office has it.
- Default port 41510, ephemeral when busy and no `--port` was given, so an installed PWA keeps its origin; the manifest's `id: "./"` keeps the app's identity across token changes. Banner: `Poke Agents running at <url>`.

### Demo mode (`--demo`)

`poke-agents --demo` (`npm run demo`; the Mac app's `--demo` launch flag or `POKE_AGENTS_DEMO=1`) replaces the Conductor provider with `server/src/providers/stream/demo/` (`createDemoProvider`): synthetic sessions only, no Conductor request, no `conductor-state.json`, no poller lock. It is for README screenshots, people without Conductor Pro, and manual checks. `--demo` can't be combined with `--claude`.

- **Provider**: registers as `id: 'conductor'` (`displayName` "Conductor demo"), so every Conductor path works unchanged: the webview's mode gating and chrome, `conductorDriver(ctx)` session actions, `agentDetails.conductorSessionId`, the Mac app's notifications. `conductorStatus` is `connected` with `account` "demo mode, synthetic sessions" and no `lastSyncAt`. Tool status text, reading/subagent tool sets and context windows are the Conductor provider's.
- **Files**: `world.ts` (`DemoWorld`: per-session fake state and action queues played against script time; emits through the `AgentEventSink` exactly as the poller does: adoption seeds inside `seedSilently`, children before their Lead so a Lead is created legendary, the spawned link before the child's adoption so it is thrown out of the Lead, details throttled to 1.5 s, the session list throttled like the poller's), `story.ts` (the script), `cast.ts` (sessions: synthetic names, `example-org/*` repos, claude/codex/cursor models), `random.ts` (seeded mulberry32), `constants.ts`, `demo.ts`.
- **Story**: round 0 (300 s) is fixed for every seed: the Lead spawns five workers over ~20 s; "Update docs" finishes at ~27 s and falls asleep two minutes later (~147 s); "Review PR #42" asks an AskUserQuestion at ~27 s (the Lead answers at 200 s if nobody did); "Fix flaky tests" faints at ~35 s and the Lead revives it at 75 s; "Triage nightly alerts" (Lv 15, Codex) evolves at ~57 s; "Prototype pricing page" is deposited at 24 s (the PC Box's session); "Perf pass" fills its context and compacts; "Onboarding copy tweaks" is hidden and "Dependency bumps" pinned. Later rounds hand every worker a new task with the same beats; `--demo-seed` varies only the generated history, the replies and later rounds. `--demo-speed` / `POKE_AGENTS_DEMO_SPEED` scale script time (0.25-20).
- **User actions** act on the fake state: a message to an idle session runs a short turn and a reply, to a busy one an acknowledgement, to a fainted one its scripted revive (else a generic one), to an asking one answers the question; stop ends the turn (`aborted`); deposit, withdraw, hide, pin and scope work as in the poller. `openExternal` is refused ("This is a demo session…"). Pokédex detail = the newest 40 entries (5 tool rows); history pages of 30 with `t<index>` cursors, over a generated back-story for sessions that existed before the start.
- **Persistence**: no stream memory (every run replays the same story from the start); seats and agents in `demo-state.json` (`FileStateAdapter` `stateFileStem`), settings shared with the standalone office. `StandaloneAccess.demo` keeps a demo office and a real one from reusing each other.
- **Tests**: `server/__tests__/demoProvider.test.ts` drives the real `StreamAgentDriver` with fake timers and no network (adoption, legendary Lead, spawns, links, messages, faint and revive, the question, evolution, compaction, PC Box, user actions, history, determinism).
- **README screenshots** (`docs/screenshots/`): captured from `--demo` only, on a throwaway `HOME` with no Conductor credentials in the environment, never from a real Conductor account (real session and repository names are private). Round 0 is fixed, so the same moments recur: at ~50-75 s "Fix flaky tests" lies fainted in a Pokémon Center bed, "Review PR #42" waits on its question and "Triage nightly alerts" has evolved. PNGs are palette-quantized (no dithering) to stay well under 600 KB each. They are the only Pokémon art in the repository: they show PMDCollab sprites, so the README's Credits names each species in them and its artists (as Settings → About & credits lists them); update that list whenever a screenshot's species change.

### The Mac app (`desktop/`)

A visualizer only: it runs the Conductor-only office (`startStandalone({ conductor: true, claude: false, terminal: false, music })`, with the CLI's Jukebox; with the `--demo` launch flag, the demo office instead, see "Demo mode"), never agents, hooks or a PTY, never writes Conductor settings, and adds no Conductor writes of its own. macOS asks once before the Jukebox controls Music or Spotify (`NSAppleEventsUsageDescription` in `electron-builder.yml`'s `extendInfo`); without the hardened runtime no automation entitlement is needed.

- **Server**: in-process in the Electron main process, or **reused** from a running `poke-agents` with the same `StandaloneAccess` (a default `npm start` matches). Reused → the app watches the owner's PID and starts its own office (same port 41510 when free, same persisted token) when it exits. **Reconnect to Conductor** (app menu, or the sign-in card's Reconnect button through the preload) = stop + start the in-process office (re-reads `CONDUCTOR_API_KEY`/Keychain); the next settled `conductorStatus` decides the feedback (`reconnect.ts`: a dialog when it is still `authRequired`/`unauthorized`). `StandaloneOffice.conductorStatus()` lets the feed catch up on a status sent before it subscribed. For a reused office Reconnect only explains how to restart `npm start`. The in-process office takes the Conductor poller lock like any office (released on stop, so Reconnect takes it again); beside an office in another mode that holds it, the app shows no Conductor sessions and `conductorStatus()` stays null. The window loads `office.url` itself (no launch code: no browser command line carries it), a loopback Host with the token, so the office is privileged; the smoke run fails when it shows "View only". Quit (`will-quit`) awaits `office.stop()` (5 s cap), then quits on a later turn: a quit requested while `will-quit` is still dispatching is swallowed.
- **Data**: `~/.pixel-agents/` shared with the CLI. Window frame: `<userData>/window-state.json` (`placeWindow` clamps it to the current displays); one-time events (the notifications introduction): `<userData>/app-state.json`. Packaged office: `Contents/Resources/office/{webview,assets}`; dev: `desktop/dist/office/`.
- **Window**: `contextIsolation`, `sandbox`, no node integration, DevTools only unpackaged; `nativeTheme.themeSource = 'dark'` (the office is always dark); title fixed to "Poke Agents"; background `#1a1c2c` before first paint; min 720×480. Menu (`menu.ts`): macOS needs an explicit File → Close Window (`role: 'close'`, ⌘W): the `windowMenu` role has no Close. **Preload** (`preload.ts`, bundled to `dist/preload.js`): `window.pokeAgentsDesktop` = `reconnectConductor()` (IPC; main accepts it only from the office window at the office origin) and `onCommand()` for app commands (`openSession` from a notification click, `openSettings` from ⌘,), buffered until the office subscribes; `webview-ui/src/hooks/useDesktopCommands.ts` handles them (a session not yet in the office opens when it arrives, within 10 s). Navigation: office origin only; http(s) → `shell.openExternal`; Conductor deep links → `shell.openExternal` after the server's `isAllowedExternalUrl`; everything else, popups and `<webview>` blocked. Permissions: only `clipboard-sanitized-write`. Single-instance lock (a second launch focuses the window); closing the window keeps the app in the Dock.
- **Notifications and badge** (`attention.ts`, fed by `officeFeed.ts`): a notification on the change INTO waiting-for-input, permission, or error ("Pikachu needs your answer" / "… needs your permission" / "… fainted!", body = session name; the session name leads when the theme is off). Never for `silent` messages, the first 5 s of a session in the office (adoption replays its state non-silently), 8 s after a feed reconnect, or the same session+reason within 2 min; skipped while the window has focus. Past 3 per 30 s notices are held and `flush()` sends them as one "N more sessions need you" when the window has room (the notifier's timer). Notice id = `<agentId>:<kind>` (groupId = agentId; summary id `summary`): a repeat replaces it, and it is withdrawn (`Notification.remove`, macOS) when the reason clears or the session leaves; `removeAll()` on office reset and quit. Click → `openSession` (that session's Pokédex). Badge = sessions waiting for input or a permission; macOS shows it only with notification permission, so the first `connected` status shows a one-time introduction notification (the permission prompt at a calm moment). The tracker reads the in-process store (`agentAdded` → `agentCreated`, `agentRemoved` → `agentClosed`, broadcasts) or, for a reused office, a TOKENLESS `/ws` (watch-only is enough) that sends `webviewReady` for the replay.
- **Sign-in from Finder**: no shell env, so `CONDUCTOR_API_KEY` is usually absent and the Keychain path does the work. The window's user agent carries `PokeAgentsDesktop/<version>`; `webview-ui/src/desktopApp.ts` detects it, `signInSteps()` words the steps for the app (Terminal login, click Reconnect, Allow the Keychain prompt), and `conductorStatusLine(status, now, isDesktopApp)` ignores the server's env-var/restart message for `authRequired`/`unauthorized`. A Keychain Deny looks like "no sign-in" to the server (`resolveConductorAuth`); Reconnect re-prompts. No in-app key entry: writing the Conductor CLI's Keychain item would override Conductor's own sign-in.
- **Never print the office URL** from the app (it carries the token); the smoke run prints host:port only.
- **Build**: `desktop/scripts/build.mjs` bundles `src/electron/main.ts` with the server (Fastify included) into `dist/main.js` and the preload into `dist/preload.js`; `npm run app:mac` packs for the host arch (`scripts/dist-mac.mjs`; `app:mac:all` for both). electron-builder packs only those plus `package.json` (`!**/node_modules/**`: it would otherwise copy the repo workspace's production deps, PTY prebuilds included), and `verify-bundle.cjs` fails the build otherwise. `desktop/package.json`'s version must equal the root's (build and test check). Electron 45 downloads its binary on first run (no install script). Cross-building the mac `dir`/`zip` targets works on Linux but cannot sign, and Apple silicon refuses unsigned apps: build on the Mac.
- **Linux smoke**: `cd desktop && xvfb-run -a node_modules/.bin/electron . --no-sandbox --disable-gpu --smoke --smoke-out=<png>` starts the office, waits for the canvas and party slots (or the sign-in steps), captures the window, checks the preload bridge and that the office is privileged (not "View only"), and exits 0. GET-only: it clicks nothing. `--smoke-reconnect` (only meaningful without a Conductor sign-in) clicks the sign-in card's Reconnect and waits for the app's answer (`noSignIn`, or `attached` beside `npm start`).

## Server Runtime

`AgentRuntime` (`server/src/agentRuntime.ts`) is the shared lifecycle core. Both surfaces (`adapters/vscode/PixelAgentsViewProvider.ts` and `server/src/standalone.ts`, shared by the CLI and the Mac app) compose the same runtime; only the `StateAdapter` namespace, `MessageTransport`, and `TerminalAdapter` differ.

```typescript
export class AgentRuntime {
  constructor(opts: {
    store: AgentStateStore;
    providerRegistry: ProviderRegistry;
    layoutPersistence: LayoutPersistence;
    assetCache: AssetCache;
    config: Pick<AdapterSettings, 'hooksEnabled' | 'watchAllSessions'>;
    terminalAdapter?: TerminalAdapter;
    callbacks: RuntimeLifecycleCallbacks;
  });
  registerAgent / unregisterAgent / removeAgent / removeTeammate / removeTeammates
  restoreExternalAgents / handleHookEvent
  startProjectScan / startExternalScanning / startStaleCheck
  dispose();
}
```

Owns timer Maps (waiting, permission, text-idle, stale), scanners (project-dir 1 s, external 3 s, stale 30 s), `HookEventHandler`, `SessionRouter`, `DismissalTracker`. Scanners are skipped entirely while hooks are flowing (`hookDelivered` is set on every agent). `RuntimeLifecycleCallbacks` is the only seam between runtime and host.

### AgentStateStore

EventEmitter-backed container in `server/src/agentStateStore.ts`. Typed mutations, typed events (`agentAdded`, `agentRemoved`, `agentUpdated`, `broadcast`). The broadcast layer subscribes once at boot and translates `StoreEvents` into `ServerMessage` over the active transport. **No module under `server/` calls a transport method directly.**

### SessionRouter and DismissalTracker

Two extracted classes that replaced ad-hoc module state. `SessionRouter` owns `session_id → agent_id` mapping, pre-registration event buffering, and pending external sessions. `DismissalTracker` unifies four legacy globals (`dismissedJsonlFiles`, `clearDismissedFiles`, `seededMtimes`, `pendingClearFiles`) into one class with typed reasons.

### HTTP + WebSocket Server

Fastify v5 with `@fastify/cors`, `@fastify/websocket`, and (in standalone) `@fastify/static`:

| Method | Path                     | Purpose                                               |
| ------ | ------------------------ | ----------------------------------------------------- |
| POST   | `/api/hooks/:providerId` | Bearer-authenticated hook event ingress               |
| GET    | `/api/health`            | Liveness: `{ ok, version, port, pid }`                |
| GET    | `/ws`                    | Bidirectional protocol channel                        |
| POST   | `/api/launch-code`       | Bearer (standalone): one-time `--open` code           |
| GET    | `/launch/:code`          | Redeems a launch code once, 302 to `/?token=…`        |
| GET    | `/api/pokemon/:dex4/…`   | Sprites and portraits from the PMD cache (standalone) |
| GET    | `/api/pokemon/cry/:dex4` | A species' cry from the cry cache (standalone)        |
| GET    | `/api/sounds[/:event]`   | The user's sound pack: list, one file (standalone)    |
| GET    | `/*` (standalone only)   | Webview SPA via `@fastify/static`                     |

`/ws` is gated in **two tiers**, because messages over this socket launch shells, grant durable machine-wide hook consent, and rewrite persisted state.

1. **Connection** (`isAllowedWebSocketOrigin` plus the Host gate): embedded requires the Bearer token; standalone requires a same-origin handshake **and** an allowed `Host`: a loopback name, an IP literal, the specific `--host`, or an `--allowed-host` name. Any other DNS name is refused, because DNS rebinding needs a hostname: a rebound page sends `Origin` and `Host` as the same attacker-chosen name, and before this gate it got a read-only socket carrying every broadcast (Conductor session lists, tool status text, link previews) on the predictable port 41510. LAN watchers keep working by IP address. A missing Origin still connects (non-browser clients send none). The gate is `wsAuth.standaloneConnectionHostAllowed`; a refused name closes with 4003 `forbidden host`, is logged once with an `--allowed-host` hint, and the SPA's transport stops reconnecting and says the same (`httpServerWs.test.ts` pins the refusal). The sprite route (and the cry and sound-pack routes) is stricter: its Host must be one a privileged handshake accepts (loopback, a specific `--host`, an `--allowed-host` name), `Sec-Fetch-Site` must be `same-origin` or `none`, and it serves only species in the catalog or shown by an agent, answering 404 before the cache is touched.
2. **Privileged messages** (`standaloneTokenValid`, `ClientMessageContext.privileged`): proved by an out-of-band secret — embedded via its Bearer token, standalone via the server token in the `/ws` `?token=` query, which the CLI prints in the local URL and the SPA forwards (`webview-ui/src/transport/index.ts`). **Never a network position**: peer address, `Host` and `Origin` all ride the channel a proxy speaks, so a LAN-bound forwarder piping bytes to 127.0.0.1 satisfies all three. The token is a replayable bearer capability, not evidence of locality — it reaches browser history (Fastify's request log redacts it, `wsAuth.redactTokenQuery`), so the printed URL is documented to the user as a secret. Standalone persists it in `~/.pixel-agents/standalone-token` (0600) so a bookmarked URL survives restarts; `--rotate-token` replaces it (revoking every device at once; refused while another standalone server is running, since it would keep honouring the old one). The terminal socket (`/terminal/:agentId`) carries it the same way and both sockets decide privilege with ONE predicate, `wsAuth.standaloneHandshakeVerdict`: the token AND an allowed `Host` — loopback, a specific `--host`, or a name passed with `--allowed-host` (anti-DNS-rebinding defence in depth). The allowlist is explicit rather than "loopback when loopback-bound" because a reverse proxy (Tailscale Serve) forwards to 127.0.0.1 under its public name; a loopback-only rule forced `--host 0.0.0.0`, exposing the port and the token in transit to the LAN. **An unprivileged client is read-only**: it may load and watch the office (`webviewReady`) and NOTHING else — every other message is refused by one gate at the top of `handleClientMessage` (`refuseReadOnly`), so a new message type is privileged by default. Where the UI updates optimistically (settings toggles, hooks toggle, asset directories, area mappings), the refused client is re-sent the real state. A tokened connection under an unlisted Host is read-only too and logs the `--allowed-host` hint. A second standalone launch reuses a running server only when its access matches (`ServerConfig.standalone`: terminal on/off, bind host, allowed hosts) — otherwise `--no-terminal` would silently attach to a server with a shell.

The **hooks preference is persisted only after the install/uninstall settled and the on-disk result agrees** — writing it first strands the user when an uninstall fails: entries still firing, but a persisted hooks-off makes the next startup skip the consent/install path entirely.

Server discovery written to `~/.pixel-agents/server.json` with `{ port, pid, authToken }`. Multi-window safe: a second server detects an existing `server.json` and reuses or replaces it based on PID liveness.

### ClientMessageHandler

Single dispatch point for `ClientMessage`. Each variant calls into `AgentRuntime`, `AgentStateStore`, `LayoutPersistence`, or `FileStateAdapter`, or delegates to host-specific callbacks (`onLaunchAgent`, `onOpenSessionsFolder`, `onExportLayout`, `onImportLayout`, `onSetHooksEnabled`). Both surfaces wire the same handler.

### ServerAgentState (server/src/types.ts)

Per-agent runtime data: provider reference, session key, transcript-fallback fields (`jsonlFile`, `fileOffset`, `lineBuffer`), tool state Maps and Sets, team fields (`teamName`, `agentName`, `isTeamLead`, `leadAgentId`, `teamUsesTmux`), context usage (`contextTokens`, `maxContextTokens`, `sawMainChainUsage`), and the **`hookDelivered`** flag that suppresses heuristic timers when hooks are flowing.

## Persistence

```
~/.pixel-agents/
  config.json              { vscode, standalone, externalAssetDirectories, hooksConsent, hooksEnabled (both per-provider) }
  vscode-state.json        { agents, seats }
  standalone-state.json    { agents, seats, streamAgents }  (agents keep toolCallCount, the level of --claude agents; streamAgents: 'conductor:<uuid>' → { agentId, pokemonLine, species, shiny }; saved seats merge, keeping the seat of any live or remembered session)
  layout.json              OfficeLayout (shared across surfaces; until one is saved, standalone shows the Pokémon Town, VS Code the classic office)
  server.json              { port, pid, authToken }
  hooks/claude-hook.js     Bundled hook script (CJS, shebang)
  conductor-state.json     Conductor scope + per-session { hidden, pinned, restoredAt, cursor, harness, firstSender, lastActivityAt, seenAt } (0600, never the token)
  conductor.lock           { pid, port } of the one office polling Conductor (0600)
  demo-state.json          { agents, seats } of the --demo office (never streamAgents)
  cache/pmd/               Runtime-downloaded Pokémon sprites, portraits and metadata
  cache/cries/             Runtime-downloaded Pokémon cries (<dex4>.ogg + .etag)
  sounds/                  The user's sound pack: <event>.(ogg|mp3|wav), read-only to the app
```

The data directory and the `[Pixel Agents]` log prefixes keep upstream's names on purpose: renaming `~/.pixel-agents` orphans settings and the hook identity. A standalone server is reused only when its access matches, including its `conductor`, `claude` and `demo` modes.

`FileStateAdapter({ namespace })` backs both runtimes. Per-namespace settings: `soundEnabled`, `lastSeenVersion`, `alwaysShowLabels`, `watchAllSessions`, `hooksInfoShown` (the hooks preference is per-provider and machine-global, at the config top level). Running both surfaces in parallel never clobbers either.

`migrateVsCodeState` (VS Code adapter only) walks each known legacy key once with **verify-before-clear** semantics: write to file, read back, only then clear the legacy key. While anything remains unmigrated, activation shows a non-blocking warning.

Layout writes are atomic via tmp + rename. Cross-window watching is hybrid (`fs.watch` + 2 s polling). `markOwnWrite()` prevents the watcher from re-reading our own write.

## Agent Status Tracking

JSONL transcripts at `~/.claude/projects/<project-hash>/<session-id>.jsonl`. Project hash = workspace path with `:`/`\`/`/` → `-`.

**JSONL record types**: `assistant` (tool_use or thinking), `user` (tool_result or text prompt), `system` with `subtype: "turn_duration"` (reliable turn-end signal), `progress` with `data.type`: `agent_progress` (sub-agent tool_use/tool_result, non-exempt tools trigger permission timers), `bash_progress` (Bash output — restarts permission timer), `mcp_progress` (MCP tool — same timer restart). Also observed but not tracked: `file-history-snapshot`, `queue-operation`.

**File watching**: 500 ms polling with partial-line buffering for mid-write reads. Tool-done messages delayed 300 ms to prevent React batching from hiding brief active states.

### Dual-mode detection

| Mode                     | Source                                                 | Detection                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hooks** (preferred)    | Claude Code Hooks API → HTTP POST → `HookEventHandler` | Instant, reliable. Installed events are `CLAUDE_HOOK_EVENTS`. `UserPromptSubmit`/`TaskCreated` are deliberately NOT installed — they normalize to null, so installing them only forwarded prompt text to be dropped; `normalizeHookEvent` still tolerates them for stale installs |
| **Heuristic** (fallback) | Polling JSONL files                                    | Per-agent 500 ms JSONL polling for /clear detection; 1 s main scanner for terminal adoption; 3 s external scanner; 30 s stale check. Content-based /clear detection (`/clear</command-name>` in first 8 KB)                                                                       |

The `hookDelivered` flag (per agent) and `hooksEnabled` (global) gate timer logic. JSONL polling always runs in both modes for tool content (status text, animations); only permission (7 s) and text-idle (5 s) timers are suppressed by `hookDelivered`.

### Sub-agent permission detection (heuristic)

When a sub-agent runs a non-exempt tool, `startPermissionTimer` fires on the parent agent. If `PERMISSION_TIMER_DELAY_MS` (7 s) elapses with no data, permission bubbles appear on both parent and sub-agent characters via `agentToolPermission` + `subagentToolPermission` broadcasts.

`activeSubagentToolNames: Map<parentToolId, Map<subToolId, toolName>>` tracks which sub-tools are active for the exempt check. Cleared when data resumes, Task completes, or `turn_duration` arrives.

**Timing budget for tests**: the test waits for the bubble AFTER waiting for the "Subtask:" overlay. But the Subtask overlay appears when the parent's **Task tool_use** is parsed (scenario time T), while the timer only starts when the **sub-tool tool_use** in the progress record is parsed (~1 s later). Plus 7 s timer + 300 ms IPC/render slop = a wait timeout less than ~10 s is unsafe.

### Context usage (server/src/contextUsage.ts)

Every agent's context gauge. Fed from `message.usage` on assistant records by `processTranscriptLine`, broadcast as `agentContextUsage` and rendered by `ToolOverlay`.

- **Snapshot, not a total.** Context = the newest turn's `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`. Summing turns measures spend, not occupancy, and misses the cached tokens that ARE the context (`input_tokens` is single digits once caching kicks in). Falls on compaction and `/clear` for free.
- **All-zero usage means "no news"** — synthetic records (API errors, interrupts) report zeros and must not blank the gauge.
- **Sidechain rule**: a lead's sidechain records are its sub-agents' turns and must not move its gauge; a teammate's own transcript is sidechain top to bottom and would otherwise never report. Positional latch (`sawMainChainUsage`): once a file produces a main-chain turn, later sidechain records belong to someone else.
- **The window comes from the provider**, not from the runtime: `HookProvider.contextWindowForModel(model)` (Claude: 1M for the current line, 200k for Haiku and the older models, `undefined` for ids it can't place). Transcripts state usage but never the limit, and guessing 200k for a 1M model reads five times too full. `widenContextWindow` is the backstop for unrecognized models and unknown-larger windows — it only ever widens, since a context that doesn't fit disproves the assumption while a shrinking one proves nothing.
- **`seedContextUsage` runs once per agent in `startFileWatching`** — the single seam every watched agent passes through. Agents adopted or restored mid-session start at end-of-file, so without a tail read they'd have no gauge until their next turn.
- Sub-agents get no gauge: no session of their own, and the shadow store never forwards `agentContextUsage`.

## Office UI

**Rendering**: Game state in imperative `OfficeState` class (not React state). Pixel-perfect: zoom = integer device-pixels-per-sprite-pixel (1x–10x). No `ctx.scale(dpr)`. Default zoom = `Math.round(2 * devicePixelRatio)`. Z-sort all entities by Y. Pan via middle-mouse drag (`panRef`). **Camera follow**: `cameraFollowId` (separate from `selectedAgentId`) smoothly centers camera on the followed agent; set on agent click, cleared on deselection or manual pan.

**UI styling**: Pixel art aesthetic — sharp corners (`borderRadius: 0`), solid backgrounds (`#1e1e2e`), `2px solid` borders, hard offset shadows (`2px 2px 0px #0a0a14`, no blur). CSS variables in `index.css` `:root` (`--pixel-bg`, `--pixel-border`, `--pixel-accent`, ...). Pixel font: FS Pixel Sans (`webview-ui/src/fonts/`), loaded via `@font-face`, applied globally.

Custom ESLint rules (`eslint-rules/pixel-agents-rules.mjs`) enforce: `no-inline-colors` (hex/rgb/rgba/hsl/hsla literals only in `constants.ts`), `pixel-shadow` (must use `var(--pixel-shadow)` or `2px 2px 0px`), `pixel-font` (must reference FS Pixel Sans). All `error`-level — they block PRs.

**Characters**: FSM states — active (pathfind to seat, typing/reading animation by tool type), idle (wander randomly with BFS, return to seat after `wanderLimit` moves). 4-directional sprites, left = flipped right. Tool animations: typing (Write/Edit/Bash/Task) vs reading (Read/Grep/Glob/WebFetch). Sitting offset: characters shift down 6 px in TYPE state. Z-sort uses `ch.y + TILE_SIZE/2 + 0.5` so characters render in front of same-row furniture but behind lower-row furniture. **Chair z-sorting**: non-back chairs use `zY = (row+1)*TILE_SIZE` (capped to first row); back-facing chairs use `zY = (row+1)*TILE_SIZE + 1` so the chair back renders in front of the character. Chair tiles are blocked for all characters except their own assigned seat (per-character pathfinding via `withOwnSeatUnblocked`).

**Diverse palette assignment**: `pickDiversePalette()` counts palettes of current non-sub-agent characters; picks randomly from least-used palette(s). First 6 agents each get a unique skin; beyond 6, skins repeat with a random hue shift (45–315°) via `adjustSprite()`. Character stores `palette` (0-5) + `hueShift` (degrees). Sprite cache keyed by `"palette:hueShift"`.

**Spawn/despawn effect**: Matrix-style digital rain animation (0.3 s). 16 vertical columns sweep top-to-bottom with staggered timing. Spawn: green rain reveals character pixels. Despawn: character pixels consumed by green rain trails. `matrixEffect` field on Character (`'spawn'`/`'despawn'`/`null`). Normal FSM is paused during effect. Restored agents (`existingAgents`) use `skipSpawnEffect: true` to appear instantly.

**Sub-agents**: Negative IDs (from -1 down). Created on `agentToolStart` with "Subtask:" prefix, or lazily by `subagentToolStart` when missing (watched background spawns, post-reload recreation). Same palette + hueShift as parent. Click focuses parent terminal. Not persisted. Spawn at the closest free walkable tile to the parent (`closestFreeWalkableTile`) — around it, never in a seat. Idle (stop typing) when every tracked sub-tool row is done; overlay shows the latest non-done sub-tool status, falling back to the Subtask label.

**Speech bubbles**: Permission ("..." amber dots) stays until clicked/cleared. Waiting (green checkmark) auto-fades 2 s. Sprites in `spriteData.ts`.

**Sound notifications**: Ascending two-note chime (E5 → E6) via Web Audio API plays when waiting bubble appears (`agentStatus: 'waiting'`) for upstream agents; stream agents' sounds are the Pokémon sounds (see "Pokémon Theme"), and `audio/chimeHandoff.ts` keeps them from chiming too. `notificationSound.ts` manages the one AudioContext; `unlockAudio()` on canvas mousedown (and any pointerdown, pointerup, touchend, click or keydown, from `usePokemonSounds`) resumes it (webviews start suspended). The on/off switch (Settings → Sound → Sounds) is persisted per-namespace in `~/.pixel-agents/config.json`.

**Mobile shell** (standalone only): below `MOBILE_MEDIA_QUERY` the browser renders `mobile/MobileShell` instead of the desktop layout — office and terminal as two full-screen pages in a 200%-wide sliding track (both always laid out, never `display:none`, so the canvas and xterm keep dimensions); the track's transform makes it the containing block of `position: fixed`, so modals and other viewport overlays mount at App's top level, never inside the office region), the agent cards in a bottom scroller, and `MobileKeyBar` above the software keyboard. "Keyboard open" and "clamp the shell" are separate answers (`mobile/keyboardViewport.ts`, sampled by `useKeyboardViewport`) because the two resize policies differ: iOS shrinks only the visual viewport (open, and the shell is clamped to it so the PTY resizes instead of hiding its input line), Android `interactive-widget=resizes-content` shrinks both (open, nothing to clamp). Open = an editable focused AND the visual viewport `KEYBOARD_MIN_HEIGHT_PX` below the tallest height seen at the current width (per-orientation baseline). `useIsMobile` is gated on `isBrowserRuntime`: a narrow VS Code panel must never get it (it broke every VS Code e2e shard once). Navigation rules live in `useMobileShell`: the >_ / Office toggle and the edge swipe share one handler; a card tap in the office is two-step (focus the character, then open its terminal), in the terminal it switches panes; + slides over only for launches made from it (a reload re-announcing sessions stays on the office). The terminal-pane model (active vs shown pane, socket status, `statusFor`) is `useTerminalDrawer`, shared with the desktop drawer. Touch rules: every gesture tracks ONE finger by identifier (`findTouch`) and uses one tap slop (`withinTapSlop`); gesture decisions are pure reducers with thin DOM adapters (`edgeSwipe.ts`/`useEdgeSwipe.ts`, `terminal/touchGesture.ts`/`touchInput.ts`), because WebKit keeps addressing a gesture's events to its touchstart node — when terminal rows repaint, that node detaches and events stop bubbling, so each adapter binds "rescue" listeners on the touch target. **Terminal copy is verbatim by default** (Cmd/Ctrl+C, the browser's Copy, the pill's Copy): `flowTerminalCopy` is a heuristic that joins a long row with a two-space-indented next line, which is also what YAML under a long key or a method body under a long signature look like, so re-flowing is opt-in only — Alt+C (Option+C) on desktop, "Copy as text" on the pill. Every write goes through `terminal/clipboard.ts`. PWA: `manifest.webmanifest` (icon paths relative — the file is served verbatim), conventional-path icons in `public/`, `?v=N` cache-busters on icon links.

**Seats**: Derived from chair furniture. `layoutToSeats()` creates a seat at every footprint tile of every chair. Multi-tile chairs produce multiple seats keyed `uid` / `uid:1` / `uid:2`. Facing direction priority: 1) chair `orientation` from catalog (front→DOWN, back→UP, left→LEFT, right→RIGHT), 2) adjacent desk direction, 3) forward (DOWN). Click character → select (white outline) → click available seat → reassign.

**Pokémon Town (Area roles)**: an Area may carry `role: 'meadow' | 'center' | 'lectern'` (`AreaDefinition.role`; rename, recolor, export and import keep it, and the Areas tool paints role tiles like any Area). `areaRoleTiles(layout)` returns the role tiles, or null when there are none — then `OfficeState.town` is null and every character runs the upstream FSM unchanged (the classic office and user layouts). With roles, `townGoalFor()` (`engine/townBehavior.ts`, pure) decides per frame for **inactive** non-sub-agents: errored → `center` (walk there with the Walk anim, then rest and faint until revived), awaiting input or a permission → `stay` (keeps its pose, usually seated at its desk), otherwise `meadow` (walk out after `TOWN_MEADOW_DELAY_SEC`, then wander with Meadow tiles as the only destinations, a pause of `WANDER_PAUSE_*` between strolls; a Pokémon about to fall asleep, `SLEEP_DROWSY_MS` before it, starts no new stroll and walks to the Meadow first if it isn't there; once asleep it never moves). Active agents always get null: the seat logic is untouched, so a revived agent walks back to its desk. Walks and stand-ups still run through `updateCharacter` (with no seats, so a stroll never ends in a chair). Destinations (`pickTownTile`) avoid where other characters are settling (the tile each walks to, or stands on when still) and prefer tiles `TOWN_SPREAD_TILES` (Chebyshev) from all of those, so wanderers spread out; town walks (`townPath`) keep off `pathBlocked`, the walk-behind tiles outside the role areas (under the forest's canopy, across a desk's top), unless a character already stands in there. A fainted character rests in a **bed** first (`townBeds`: a placed item two or more tiles wide that is background throughout, inside the Center; its pillow end is the one nearer the Center's side wall, its sleeper stands at the other end of its bottom row — `x` moved to the bed's middle — facing the pillow, `Character.bedRest`, with the bed's foreground pixels (its blanket below an arched fold, alpha 254 like tall grass) drawn again just after it, so it lies tucked in; it gets out of bed when it walks or its goal changes). **How it lies** (`engine/bedLie.ts`, pure: `lieInBed`): the pose the faint holds in the row it lies in (`getPokemonPose`, its full box: left, right, rise, drop), or theme off the upstream sprite's opaque box (`spritePoseBox`); a pose taller than it is wide (an upright Sleep frame standing in for a missing Faint, a human) is turned a quarter, its top to the pillow (`pokemonDrawPlace`; the renderer rotates about the ground point). The body lies on the mattress between the boards (`BED_BOARD_PX`), its head end `BED_PILLOW_INSET_PX` in from the pillow end (centred over both boards when longer than the mattress), its lowest pixel `BED_SLEEPER_BASE_PX` above the bed's bottom edge, sinking toward the front (to `BED_SLEEPER_SINK_LIMIT_PX`) rather than rising above the bed. `bedLieOf` feeds the ground point (`pokemonGroundY`), click box (`drawnBody`), overlay anchors (`overlayAnchorX`/`overlayAnchorY`, `bodyTopY`) and link ends. The fit (`RestFit`) is the held Faint frame's reach, measured per sheet row (`getPokemonRestPose`): a bed takes a sleeper whose half-width fits its `room` plus `TOWN_WALL_OVERLAP_PX`; `centerRestTiers` puts beds with no sleeper above or below first, never puts a sleeper whose rise exceeds a bed's `headroom` under a taken bed or anyone under a tall sleeper (`TOWN_BED_OVERLAP_PX`; occupancy maps carry each occupant's rise), then floor tiles whose `centerClearance` covers `townRoomNeeded(halfW)`, then the widest floor tiles. Theme off, a fainted human lies in bed as its sprite turned on its side, head on the pillow, feet clear of the foot board. **Arriving**: for `TOWN_SPAWN_GRACE_SEC` after `addAgent`, a status that makes the character idle or fainted places it straight on a Meadow tile or a bed (the capsule opens there) instead of at its desk. **Seats** (`stewardTownSeat` → pure `townSeatMove`): `findFreeSeat` and teammate clustering skip **lectern** seats; a Lead takes a free lectern seat (or one a non-Lead holds), a non-Lead on one moves to a free desk, a working character without a seat takes a free desk or the desk of a character away in the Meadow or the Center (who becomes seatless until it next works), and a wide Pokémon at a desk with less `seatRoom` than it needs moves to a roomier free desk. A character that is away only has its claim moved; a working one walks there. Layout rebuilds leave characters that are away where they are. Seatless agents appear on a free Meadow tile; a right-click walk holds `TOWN_USER_WALK_HOLD_SEC` before the character heads back. In the town, links are drawn at `LINK_DIM_ALPHA` unless an end is the hovered or selected character or its Lead (every link's lit pixels sit on a `LINK_CASING_COLOR` pixel one row down, town or not; a link ends where its character stands, or at the middle of a body drawn off its tile — a Pokémon seated at a desk, anyone lying in a bed — `linkEnd`, so a Lead's fan starts at the Lead, not at the chair under it); a fainted character resting or walking to the Center is drawn at full alpha (still grey) with a FNT chip `TOWN_FAINT_CHIP_GAP_PX` over the top of its body as drawn (`bodyTopY`: the lying pose in the row it lies in; overlay anchors, click boxes and link ends follow the drawn pose too), its font scaled with the zoom; theme off (or without a species), the party bar's red status dot instead (`TOWN_FAINT_DOT_*`); with Always Show Labels at a CSS scale up to `TOWN_COMPACT_LABEL_MAX_SCALE`, themed labels are one-line chips (badge and `TOWN_COMPACT_LABEL_CHARS` of nickname). FNT chips and one-line labels are nudged up until none overlaps another (`liftOverlapping`, widths measured with the pixel font). In the town (not editing) the camera is clamped per axis (`clampPanAxis`): a map that fits stays centred on that axis, a larger one stops at its edge — following a character (opening its Pokédex), a manual pan (wheel, drag, pinch: `clampManualPan`) and after a zoom or a resize (the render loop pulls the pan back). Elsewhere, and while editing, a manual pan keeps `PAN_MARGIN_FRACTION`. An active session with no tool running reads **Working**, not Idle (`getActivityText`, everywhere). **Static layer** (`engine/staticLayer.ts`, pure): in the town, the walls and items no character is expected to be drawn behind — most of the forest, the back walls and what hangs on them — are drawn once into the ground cache instead of z-sorted every frame (`OfficeState.staticFurniture`, `staticWallTiles`, `staticLayerVersion`); characters are expected on the role areas, seats and the open ground joining them, not under walk-behind canopy, and a character or pet that steps onto an unexpected tile adds it and the layer is worked out again (`keepStaticLayerHonest`). Items with an on/off state or an animation are never static; outside the town nothing is.

**Tall grass**: a floor pattern's pixels stored at alpha 254 (`FLOOR_FOREGROUND_ALPHA`, visually opaque) are foreground. `renderFrame` asks `foregroundPieces()` which tiles characters and pets stand on or step into, and draws those tiles' foreground (and their side neighbors') again with `zY = (row + 1) * TILE_SIZE + FLOOR_FOREGROUND_Z_OFFSET`, just after that row's characters: rows above `FLOOR_FOREGROUND_BELOW_ROW` cover the tile's own occupant, rows from it down (the lower blades) cover the occupant of the tile below, whose feet sit near the middle of its own tile. A Pokémon passes `coverTopY` so the grass covers at most `FLOOR_FOREGROUND_MAX_COVER` of its height (small species stay visible); a piece is clipped at the lowest limit among the entities it covers. Colorized halves are cached per (pattern, color) and as canvases per zoom; with no foreground pattern loaded the pass is skipped.

## Pokémon Theme

On by default (`AdapterSettings.pokemonTheme`; `setPokemonTheme` → `pokemonThemeUpdated`). Off restores the upstream look and fetches nothing. VS Code keeps upstream characters.

- **No Pokémon art in the repo.** Sprites and portraits come from the PMD Sprite Repository (PMDCollab/SpriteCollab) at runtime: CHUNSOFT art © Nintendo, Creatures, GAME FREAK and Spike Chunsoft; community art CC BY-NC 4.0, non-commercial. The local server downloads them into `~/.pixel-agents/cache/pmd/` and serves them same-origin. Settings → **About & credits** (the About modal) shows the disclaimer and per-species credits (`credits.txt`, `credit_names.txt`). Tests use synthetic PNGs (pngjs) and hand-written `AnimData.xml`. Everything Poke Agents draws itself is an original design, never a rendition, variation or recolour of an official one (no red-and-white ball, no logos, no existing Pokémon): the app icon is Promptling, a teal creature whose eyes are a `>` and a block cursor (`scripts/generate-icons.mjs`), and the thrown, recalled and flown capsule is a teal-and-cream pill with a gold collar that opens sideways (`office/sprites/capsule.json`, frames as strings; `CapsuleIcon` draws the same pixels as the PC Box and empty-office fallback). `generate-icons.test.mjs` and `capsuleArt.test.ts` fail on red or on the ball's shape. UI text says "capsule"; the sound pack keeps the file names `ballThrow`/`ballPop`.
- **Server** (`server/src/pokemon/`): `pmdCache.ts` fetches from `raw.githubusercontent.com/PMDCollab/SpriteCollab/master`, falling back to `cdn.jsdelivr.net/gh/PMDCollab/SpriteCollab@master`, with 7-day ETag revalidation, single-flight per path, concurrency 4, a 10 s timeout, a 2 MB cap, a PNG signature check and an injectable `fetch`. Paths are built only from a dex in 1..1025 plus an anim declared in that species' `AnimData.xml` (`^[A-Z][A-Za-z]{1,24}$`) or an allowlisted portrait emotion. `GET /api/pokemon/:dex4/:file`, `/api/pokemon/:dex4/portrait/:file` and the `shiny/` variants stream from the cache dir with an explicit root, the privileged Host allowlist, `Sec-Fetch-Site` `same-origin`/`none` only, species in the catalog or shown by an agent only (`isServableSpecies`), `cache-control: private, max-age=86400` and `nosniff`; standalone only. `POKE_AGENTS_SPRITES=off` or `--no-sprites` disables all fetching (CI, e2e, tests).
- **Species**: `speciesCatalog.ts` is committed metadata (`lines`, `legendaries`, `leadDefaults`), regenerated by `scripts/generate-pokemon-catalog.mjs`; the default pool excludes `size: 'large'`. `speciesAssigner.ts`: stable key = Conductor session id, else Claude session id, else agent id; the least-used line with an FNV-1a tie-break, and shiny duplicates once every line is in use; Leads get a non-large legendary from `leadDefaults` and never evolve. Level = `1 + floor(sqrt(messageCount / k))` (`k` = 2 for Codex, 4 otherwise), else `1 + floor(sqrt(toolCallCount))`, clamped to 1..100; stage 2 from Lv 16, 3 from Lv 36. `pokemonLine`, `species` and `shiny` persist. `--claude` agents level from their tool calls (`pokemon/agentLevel.countToolCall`: once per tool id from the transcript, per `PreToolUse` for hooks-only agents), announce level-ups and evolutions with `agentDetails`, and persist `toolCallCount`. `pokemonSpeciesLoaded` reaches each connection once per `dex:shiny` in use, and an evolution loads the next species before `agentDetails` announces it; a species that fails to load is announced once as `pokemonSpeciesFailed` (until it loads) and retried with backoff. `speciesDelivery` marks `settingsLoaded.pokemonSprites` (sprites on): only such a connection makes the office a Pokémon office.
- **Webview**: `office/sprites/pokemonSprites.ts` decodes sheets (`fetch → blob → createImageBitmap`), slices frames lazily and exposes DOM-free geometry (`getPokemonGeometry`); `sweepPokemonSheets` (every 30 simulated seconds, on each species arrival and when the theme turns back on) closes the ImageBitmaps of a species no character, current or evolving-to, has used for 5 minutes, keeping its metadata for credits and portraits, and a later use decodes it again; `office/engine/pokemonAnim.ts` (pure) picks the PMD anim: Walk (Idle while Walk still decodes), Idle at the desk whatever the tool (breathing; no loop ever plays Charge, Shoot or Attack), Sleep in row 0 while asleep, Pose plus `!` when waiting, Hurt then a held Faint at 60 % alpha on error, turned to greys with a cool tint (`frameGreyed`, `POKEMON_FAINT_TINT`; in the town, full alpha on the way to and in the Pokémon Center), Wake on waking. One-shots: a tool start may play Nod (reading) or Shoot, else Attack (writing, commands), a message sent Attack facing the receiver, a turn end Hop; these play only when none is playing and `POKEMON_ONE_SHOT_GAP_SEC` have passed since the last one ended (`startPokemonOneShot`), Wake and Hurt always. A loop whose frames hold under `POKEMON_LOOP_MIN_AVG_TICKS` on average is slowed to it (`pmdPlayDurations`). **Asleep** has one rule (`office/asleep.ts`, pure) the office, the party bar and the Pokédex share: done or idle (status waiting, no question, permission or open tool) with no activity for `SLEEP_AFTER_MS` (2 min). Both read the same facts: `conductor/party.ts sleepFactsOf` on the conductorStore agent (its activity is the newer of the provider's `lastActivityAt` and the live turns, tools and messages received this client saw); App hands them to `OfficeState.setSleepFacts`, which sets `Character.asleep` each frame against the wall clock, and `useSleepClock` re-renders the party the moment the next agent falls asleep. Asleep, a Pokémon holds still (a walk stops where it is), plays Sleep with a Zzz bubble and reads `SLP`/"Asleep"; leaving that state (a turn, a tool, a message received, a question) plays Wake first. **A Pokémon office** (theme on and `settingsLoaded.pokemonSprites`) never draws an upstream character: a Pokémon with no frame to show (species unknown, sheets loading, or unavailable: `pokemonSpeciesFailed` or no Idle/Walk sheet decodes, "Sprite unavailable" on its hover card) is a closed capsule resting on its ground point with a gentle bob (`renderRestingCapsule`), holding still and hit-tested as the capsule; its spawn throws the capsule, then holds it closed at the landing until the sheets are ready (at most `CAPSULE_WAIT_MAX_SEC`, after which the closed capsule just stays) and opens it in place (`startCapsuleOpen`); sub-agents take their parent's species; the greeter is Promptling (`office/sprites/promptling.json`, from the app icon's grid); party and Pokédex portraits fall back to the capsule. `renderer.getCharacterDrawStats` counts characters drawn as humans per frame (testHooks `getCharacterDrawStats`; zero in a Pokémon office). Theme off, and hosts without sprites (VS Code, `--no-sprites`), keep the upstream characters. Spawn and despawn are a capsule throw and a teal recall beam behind the `matrixEffect` field; evolution is a 1.2 s white flash. `:root[data-theme='pokemon']` restyles panels as GBA dialog boxes; team label colours are the tokens `--color-team-lead`/`--color-team-role`, and the OfficeCanvas container is `bg-bg-dark`. Overlays show the nickname, `Lv N`, the species and `SLP`/`FNT`/`!` badges; the HP bar replaces the context gauge and keeps `data-testid="context-gauge"` with `data-context-pct` = percent used.
- **Sounds** (stream agents only; upstream agents keep the chime): `webview-ui/src/audio/soundPolicy.ts` (pure `SoundDirector`) maps messages to events: needs you → alert + cry; faint → cry −4 semitones + faint slide; revived → heal; level-up (live small steps only, never the initial fill); evolution → evolution + the new cry; a Lead's new child → throw + pop + cry; any live arrival → pop + cry; `agentMessage` → whoosh; `agentClosed` → recall; done only for the selected or a pinned session; opening a Pokédex → its cry. Silent statuses, the 5 s after a (re)connect or `existingAgents`, and arrivals chained to them are quiet; theme off keeps only alerts. `soundLimiter.ts` (pure): 4 events/s, per-agent cooldowns, gaps for noisy events, one cry at a time (queue 2, stale after 2.5 s, a user cry interrupts, a playing cry holds the queue for its duration). `soundController.ts` (DOM-free, deps injected) applies the Settings switch and the Cries / Alerts / Effects toggles to every sound including the Test buttons, drops automatic sounds while the context is locked, fetches cries only after a gesture, and never throws into the transport's handler loop. `audioEngine.ts` (page deps injectable) plays nothing until a gesture unlocked the context, fades out a cry it cuts short, ducks effects under cries, lowers the Jukebox's radio and folder music under cries and alerts (`duckMusic`), and loudness-matches decoded files. Effects are original chiptune recipes (`sfxRecipes.ts`, each ≤ 1.2 s, no game melodies). Per-device prefs `pixel-agents.sound.*` (volume, cries, alerts, effects). Server: `server/src/audio/cryCache.ts` fetches `raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/{latest,legacy}/<dex>.ogg` into `~/.pixel-agents/cache/cries/` with the sprite cache's rules (validated dex, single-flight, 1 MB cap, an Ogg or MP3 signature check — Pikachu's `latest` cry is MP3 under its `.ogg` name — ETag revalidation, doubling backoff), served with the sniffed content type; `GET /api/pokemon/cry/:dex4` (the sprite route's Host allowlist and `Sec-Fetch-Site` check, catalog or in-use species only, 404 while sounds, sprites or the theme are off) and `pokemonSpeciesLoaded.cry`. `GET /api/sounds` lists and `GET /api/sounds/:event` serves `~/.pixel-agents/sounds/<event>.(ogg|mp3|wav)` (same Host and `Sec-Fetch-Site` gate, allowlisted names, regular files, 2 MB, signature check). `--no-sounds` / `POKE_AGENTS_SOUNDS=off` turns the server side off, Poke Agents Radio included. Never commit audio files; tests use synthetic `OggS` bytes.
- **Surfaces**: party bar (the themed card bar: Leads first with children nested, blinking for attention; a long slug-like name is cut in the middle, its last segments kept in view, `splitNameTail`), Pokédex panel (`SessionPanel`, Overview and Chat tabs, the open tab kept across agents; `usePokedexRefresh` sends `requestSessionDetail` on open and every 5 s while it is open and the page is visible, which keeps the Focus tier alive, and refreshes once when a hidden page is shown again), PC Box modal (portraits from the summaries' `species`/`shiny`, else the in-memory map, else the standalone portrait route `/api/pokemon/<dex4>/portrait/Normal.png` with the theme on; a shiny uses the base form's portrait; else the capsule), Sessions modal ("All" sends 0 and reads "All (30d)"; the "Active in" choices always include the window the server echoes), link lines with capsule projectiles and preview bubbles, the battle log (client-side ring of 30 events), Settings toggles (theme, Show connections, battle log), the Sound section and **About & credits** (the About modal: the visualizer principle, the `--claude` exception, the Pixel Agents credit and the sprite artists). The "Updated to vX" notice never shows on a first run (`versionNotice`). Without `claude` in `providerCapabilities.activeProviders`, the hooks settings, **+ Agent** and Directories are hidden and the Intro never appears. Stream agents are never auto-selected or camera-followed on creation.
- **Pokédex Chat tab** (`PokedexChat.tsx`, rules in `conductor/chat.ts`): the conversation thread, oldest to newest (user messages, assistant text, peer messages in and out with jump-to, and each turn's tools folded into one `<details>` line headed by `toolName`, e.g. "Bash · 41s", or "Tool"), built from `sessionDetail` entries plus `sessionHistory` pages merged by entry `key` (keyless entries fall back to role, time and text). **Load earlier** asks for the newest page once on open, then by the last `before` cursor, one request in flight per agent; a reply error or 20 s without one offers Retry, and the end reads "Start of the conversation". Scroll follows new lines at the bottom, offers "Newest ↓" otherwise, and keeps its place when older lines load. The reply box (`ReplyBox.tsx`) is shared with Overview: one send at a time, showing Sending, Sent, the `conductorActionResult` refusal (the text goes back into the box) or "no answer yet" after 15 s; Enter sends and Shift+Enter adds a line, Enter that confirms an IME composition never sends, and on phones (the sheet) Enter adds a line and Send sends. Text goes through `chatText.plainText` (markdown links and images as their text, `%XX` decoded, no `@` mention marker) and is only ever rendered as text nodes, never HTML. Recent and Chat show "Loading…" until the first `sessionDetail`, and a view-only office says it can't load the conversation. The mobile sheet is absolute inside the App root, so it follows the iOS keyboard clamp.
- **Pending question**: `sessionDetail.question` is a foldable card on top of the Chat tab with its options, and a one-line summary with "Answer in Chat" on Overview; an option button ("Reply with this option") sends the option text as a normal `sendSessionMessage`. Poke Agents only sends normal messages, so the label must not promise that it answers the question in Conductor's own UI. Statuses caused by adoption arrive `silent` (no chime) but still draw the `!` bubble.
- **Escape**: one stack (`escapeStack.ts`, registered with `useEscapeLayer`, a capture-phase listener). Escape closes the highest-z, newest open layer and stops there: a confirmation, then a modal (Sessions, Settings, PC Box, About, Changelog, Directory, Jukebox), then the Pokédex; the Intro and the migration notice register too. Escape typed in the reply box or a terminal passes through.

## Jukebox

Background music, a local nicety that never touches Conductor. It plays only music the user is entitled to; no audio is ever bundled or committed, and the only audio it downloads is Poke Agents Radio's pinned tracks.

- **Poke Agents Radio** (the first source and the default tab): `core/src/radioCredits.ts` is the credits file (id `radio-<slug>`, title, author, CC0 1.0 or CC BY 4.0, source page), shown by `CreditsModal` and mirrored in the README's "Radio credits" (`radioCatalog.test.ts` holds both to it). `server/src/music/radioCatalog.ts` is the checksum manifest for exactly those ids: the author's own file URL (`opengameart.org` or `incompetech.com`), size, SHA-256 and measured BS.1770 loudness, from which `radioGain` turns louder tracks down to `RADIO_TARGET_LUFS` (-18; never up). `radioCache.ts` downloads a track into `~/.pixel-agents/cache/music/radio/<id>.<ext>` only when the track route first asks for it (play or the player's preload of the next track): manifest ids only, single-flight, two at a time, capped at the pinned size, kept only when size and SHA-256 match (written atomically), doubling backoff after a failure; a cached copy is re-hashed once per process and whenever its size/mtime/inode change, and a mismatching one is deleted and fetched again. `radioSwitch.ts`: `--no-radio` / `POKE_AGENTS_RADIO=off` (`startStandalone({ radio })`) or the sound switch turns it off: no downloads, `radio` source unavailable with a reason, no `radioTracks`, 404 on the route. Server tests run with `POKE_AGENTS_RADIO=off` and fake fetches. To add a track: original work, CC0/CC BY read on its page, credit it, pin a fresh download's size/SHA-256/loudness.
- **Server** (`server/src/music/`, standalone only): `cli.ts` and the Mac app's in-process office each create a `MusicService` (which owns the `RadioCache`) and pass it to `startStandalone({ music })`, which hands it to the server. `folderLibrary.ts` scans `~/.pixel-agents/music/` (one folder per game; `Disc N` folders merge; titles from file names; depth, entry and track limits; symlinks followed only when the target resolves inside the folder). `GET /api/music/track/:id` (`routes.ts`) streams a scanned folder id (24 hex, re-checking the resolved path at open) or a radio manifest id (through the radio cache, which may download it first) and nothing else, with HTTP Range (206/416), `nosniff`, and the same privilege as `/ws`: the `?token=` plus the Host allowlist (`standaloneHandshakeVerdict`), checked before any download. `appleScripts.ts` holds every AppleScript as a constant; varying values travel as prefixed osascript arguments read from `argv`, never spliced into script text, and only allowlisted actions build. `macApps.ts` runs them with `execFile('/usr/bin/osascript', ['-e', script, ...args])` (injectable; tests never execute anything), on macOS only and only when the app is installed; -1743 maps to "allow Automation". Music: a Pokémon album scan of the library, and a `Poke Agents Jukebox` queue playlist marked by its description (a user playlist with that name is never cleared). Spotify: `play track <spotify: URI>`. Commands that may launch the app (Spotify play/resume, Music resume/open link) get `OSASCRIPT_LAUNCH_TIMEOUT_MS`; -2700 means "not installed" only for "Can't get application id". `stations.ts` keeps pasted links in `~/.pixel-agents/music.json` (0600), re-validating each on load; Spotify titles come from oEmbed once, on save.
- **Protocol**: `requestMusicLibrary` and `musicCommand` (privileged; `refuseMusicMessage` answers a read-only office), answered to the sender only with `musicLibrary` (sources `radio`, `folder`, `apple`, `spotify`; `radioTracks` with title, artist, type and gain, never URLs or hashes), `musicState` and `musicActionResult`. Radio and folder music play in the page; a `musicCommand` for either is refused.
- **Webview** (`webview-ui/src/music/`): `Jukebox` (mounted at App's top level for privileged browser offices) renders `JukeboxPanel` and `NowPlayingPill`; `JukeboxButton`/`JukeboxMenuItem` are the toolbar and Settings entries (the menu item ends Settings → Sound, as `SoundSettings`' children). Escape closes the panel through its `Modal`'s layer on the Escape stack, like any modal. `folderPlayer.ts` is DOM-free (injected decks) and plays both page sources: the `radio` station (`MUSIC_STATION_RADIO`; `format.ts` indexes the radio as an album with artist and gain) and folder stations (`all` or an album id). Three decks (playing, fading out, buffering the next track), a 1.5 s equal-power crossfade, deck volume = user × fade × duck × the track's gain, Media Session (a radio track's artist). With no queue, resume plays the remembered station, else every folder album, else the radio. Every fade starts from the decks' current gains, and a skip mid-fade starts the new track on a deck that isn't sounding. A decode error writes a track off; a network error, or a "source not supported" for a track the server no longer serves (HEAD), only stops and reloads it on play. `queue.ts` (loop, shuffle without immediate repeats), `mix.ts` and `duck.ts` are pure and Node-tested. `duckMusic(ms)` lowers radio and folder music while a cry or alert plays: the sound engine calls it (`AudioEngineDeps.duckMusic`) as a cry or an Alerts sound (alert, faint, done) starts, with that sound's length. `sourceSwitch.ts`: radio and folder share the page player (switching between them never pauses it); starting an app pauses it, and starting a page source pauses a playing app. Preferences: `localStorage` `pixel-agents.music.*` (source `radio` until the user picks another; `usableTab` falls back to the radio, then the folder); radio or folder music resumes on the first activating gesture after a reload, never before (`resumeOnGesture.ts`: non-Escape keydown, mouse pointerdown, touch/pen pointerup, touchend; a blocked start keeps the remembered state and listens again). `connection.ts`: the app poll skips ticks while the socket reconnects (the transport would queue them), and a drop clears pending commands. Vite dev: `musicMock.ts` (`?music=empty|linux|noradio`) streams generated silence for every track, the radio's included.

## Layout Editor

Toggle via "Layout" button. Tools: SELECT (default), Floor paint, Wall paint, Erase (set tiles to VOID), Furniture place, Furniture Copy (`FURNITURE_PICK`: type + colour off a placed item), colour Copy (`COLOR_PICK`: colour only), Eyedropper (floor/wall). `handleEditorTileAction` is a per-tool switch; the layout maths lives in pure `editorActions.ts` functions. Clicks on placed items (select, drag) never reach it — the canvas resolves them.

**Floor**: 7 patterns from `floors.png` (grayscale 16×16), colorizable via HSBC sliders (Photoshop Colorize). Color baked per-tile on paint. Eyedropper picks pattern+color.

**Walls**: Separate Wall paint tool. Click/drag to add walls; click/drag existing walls to remove (toggle direction set by first tile of drag, tracked by `wallDragAdding`). HSBC color sliders (Colorize mode) apply to all wall tiles at once. Eyedropper on a wall tile picks its color and switches to Wall tool. Furniture cannot be placed on wall tiles, but background rows may overlap walls.

**Furniture**: Ghost preview (green/red validity); `buildEditorRenderState` (`office/editor/`) builds the frame's `ghosts[]` + one `ghostValid`. R key rotates, T key toggles on/off state — a selected placed item wins over the catalog type. Drag-to-move in SELECT; **Alt-drag drops a copy** (cursor `copy`, Alt sampled live so it can flip mid-drag; the copy is left selected). The canvas only reports the gesture (`onDrop(uid, col, row, { duplicate })`); `handleDrop` → pure `dropFurniture` validates, commits and sets selection. **Desks carry their riders**: surface items standing on an `isDesk` item (`getSurfaceRiders`) move, rotate (spot swung round the desk top) and get copied with it; the whole group must fit or nothing happens. Delete button (red X) + rotate button (blue arrow) on selected items. **Selecting a placed item closes the open tool tab and opens its HSBC colour sliders** (Reset + Copy buttons); color stored per-item in `PlacedFurniture.color?`. Hit-testing is ONE `furnitureAt` (surface items win over the desk under them) — select, drag, cursor and both Copy tools agree. Placement state is `editorState.placing: { type, color? }`: the Copy tool's lifted colour styles that copy only — `color: null` is a copied ABSENCE of colour, so an uncoloured item's copy stays uncoloured under a palette colour; `undefined` (a plain catalog pick) takes `pickedFurnitureColor` (`placementColor()`); palette sliders override either. Colour Copy takes the clicked item's colour into whichever sliders armed it, then returns to that tool.

**Undo/Redo**: 50-level, Ctrl+Z/Y. EditActionBar (top-center when dirty): Undo, Redo, Save, Reset. **Stroke-scoped undo**: every edit goes through `commitLayout(layout, session)`; edits sharing `editorState.undoSession` collapse into one entry — `'stroke'` (one floor / wall / erase / carpet click-drag), `'wallColor'`, `` `color:<uid>` `` (a slider run on one item). `null` = discrete edit (its own entry; a colour eyedrop is one). Mouse up / leave, tool change, Esc, selection changes and undo/redo end the session (`endStroke`). Area paint stays per-tile.

**Multi-stage Esc**: exit furniture pick → deselect catalog → close tool tab → deselect furniture → close editor.

**Erase tool**: Sets tiles to `TileType.VOID` (transparent, non-walkable, no furniture) **and deletes any furniture whose footprint the stroke passes through** (`removeFurnitureAt`). Right-click in floor/wall/erase tools also erases to VOID + furniture (drag-erasing supported). Context menu suppressed in edit mode.

**Grid expansion**: In floor/wall/erase tools, a ghost border (dashed outline) appears 1 tile outside the grid. Clicking a ghost tile calls `expandLayout()` to grow the grid by 1 tile in that direction. New tiles are VOID. Furniture positions and character positions shift when expanding left/up. Max: `MAX_COLS`×`MAX_ROWS` (64×64). Default: `DEFAULT_COLS`×`DEFAULT_ROWS` (20×11). Characters outside bounds after resize relocated to random walkable tiles.

**Layout model**: `{ version: 1, cols, rows, tiles: TileType[], furniture: PlacedFurniture[], tileColors?: ColorValue[] }`. Grid dimensions are dynamic. Persisted via debounced saveLayout message → `writeLayoutToFile()` → `~/.pixel-agents/layout.json`.

**Templates**: the tool row's **Templates** button opens the bundled layouts (`layout/bundledLayouts.ts`: Pokémon Town, Classic Office). Loading one is an ordinary undoable edit (`applyEdit`, saved like any edit) that keeps the placed pets; when the grid size changes, characters without a seat are moved off unwalkable tiles and the camera re-centers (also on undo / redo / reset). The JSON loads as its own lazy chunk.

## Asset System

**Loading**: `esbuild.js` copies `webview-ui/public/assets/` → `dist/assets/`. Loader checks bundled path first, falls back to workspace root. PNG → pngjs → SpriteData (2D hex array, alpha≥2 = visible, `#RRGGBBAA` for semi-transparent). `loadDefaultLayout()` reads the highest `assets/default-layout-N.json` (the classic office; VS Code's default, and its `layoutRevision` reset logic). The standalone server's default is `loadStandaloneDefaultLayout()`: `assets/layouts/pokemon-town.json` (falling back to the classic one), sent only while no `~/.pixel-agents/layout.json` exists, so a saved layout is never replaced. The town keeps `layoutRevision: 1`, the classic default's, so VS Code never resets a town saved by standalone.

**The Pokémon Town's art** is original and drawn in code: `node scripts/generate-world-assets.mjs` (`scripts/world/pixels.mjs` canvas, `art.mjs` drawings, `town.mjs` layout) writes `floors/floor_9..22.png` (grass, speckled grass, tall grass in three blade variants — 11, 15, 16 — a patch's edges coloured like the grass with their blades' grays re-expressed to match (`tallGrassEdgeFloor`; the patch and the grass share hue and saturation, so lightness is all that differs): its ragged top row — 17 — its ragged left and right sides — 19, 20 — and top corners — 21, 22 — dirt, cobbles, the Center's tiles — 14 — and grass in a patch's shadow — 18), `carpets/carpet_3.png` (an auto-tiled path), the furniture folders below and `layouts/pokemon-town.json`, deterministically. Edit the code and rerun it rather than editing its PNGs. The town (37×27) is framed by tall trees in two staggered rows, has a Lab with a lectern (two seats in a `lectern` Area, a `PROFESSOR_DESK`), 18 desks (microscopes and paper stacks between some PCs) and a specimen cabinet on its back wall, a Pokémon Center with four 3×2 beds and a finished back wall (a wainscot, two pairs of windows, a poster), and a Meadow in two halves either side of the south path (the west field and the pond garden, fenced on the street with a gate and on the path side with an opening under the signpost), kept a column clear of the side forest. **No game emblems:** the Center's identity is our own plain pink heart, lit from the top left and outlined only outside (its sign; lighter at 9×8 on the healing machine's plate and the poster), never a cross or any official mark.

**Catalog**: `furniture-catalog.json` with `id, name, label, category, footprint, isDesk, canPlaceOnWalls, groupId?, orientation?, state?, canPlaceOnSurfaces?, backgroundTiles?`. String-based type system. Categories: desks, chairs, storage, electronics, decor, outdoor, wall, misc. Wall-placeable items use the `wall` category and appear in a dedicated "Wall" tab; the town's trees (`TREE`, `TALL_TREE`, `PINE_TREE`, `CYPRESS`), bushes, flowers (all-background, so walkable), fence (front/side rotation), signpost, lamp post, rock, bench, pond, the Lab and Center sign boards and the front façade (`LOW_WALL`, `LOW_WALL_WINDOW`) are in **Outdoor**; the Center's bed (`CENTER_BED`, 3×2, R swaps the pillow side) and the doormat are in Decor (both all-background: characters lie or step on them), the lectern's `PROFESSOR_DESK` in Desks, the desk clutter (`MICROSCOPE`, `PAPER_STACK`, surface items) in Misc, and `ROOF_TRIM`, `WAINSCOT`, `WALL_WINDOW`, `CENTER_POSTER` and `SPECIMEN_CABINET` in Wall (all but the bottom row background, so they share a tile with a tree trunk behind the wall). The town's buildings use the façade (colored `colorize: true` like their walls) for their front side, so it never hides the room, and a `ROOF_TRIM` on every back-wall tile (all-background, so it stacks over the wall and its wall items; placed last so it draws over them). Asset naming convention: `{BASE}[_{ORIENTATION}][_{STATE}]` (e.g., `MONITOR_FRONT_OFF`).

**Per-furniture manifests**: Each furniture item lives in its own folder under `assets/furniture/` with a `manifest.json` that declares its sprites, rotation groups, state groups (on/off), and animation frames. Floor tiles are individual PNGs in `assets/floors/`; wall tile sets in `assets/walls/`.

**Rotation groups**: `buildDynamicCatalog()` builds `rotationGroups` Map from assets sharing a `groupId`. Supports 2+ orientations (e.g., front/back only). Editor palette shows 1 item per group (front orientation preferred). `getRotatedType()` cycles through available orientations.

**State groups**: Items with `state: "on"` / `"off"` sharing the same `groupId` + `orientation` form toggle pairs. `stateGroups` Map enables `getToggledType()` lookup. Editor palette hides on-state variants. State groups are mirrored across orientations.

**Ambient animations**: an animation group none of whose frames has a `state` (the pond) loops all the time (`getAmbientAnimationFrames()`; frame time `AMBIENT_ANIM_INTERVAL_SEC`), swapped in by `rebuildFurnitureInstances` without touching the saved layout. The palette shows frame 0 only.

**Auto-state**: `officeState.rebuildFurnitureInstances()` swaps electronics to ON sprites when an active agent faces a desk with that item nearby (3 tiles deep in facing direction, 1 tile to each side). Operates at render time without modifying the saved layout.

**Background tiles**: `backgroundTiles?: number` — top N footprint rows allow other furniture to be placed on them AND characters to walk through. Z-sort places bg-row items behind the host furniture.

**Surface placement**: `canPlaceOnSurfaces?: boolean` — items like laptops, monitors, mugs can overlap with all tiles of `isDesk` furniture. `canPlaceFurniture()` builds a desk-tile set and excludes it from collision checks. Z-sort: surface items get `zY = max(spriteBottom, deskZY + 0.5)`.

**Wall placement**: `canPlaceOnWalls?: boolean` — items like paintings, windows, clocks can only be placed on wall tiles. `canPlaceFurniture()` requires the bottom row of the footprint to be on wall tiles; upper rows may extend above the map. `getWallPlacementRow()` offsets placement so the bottom row aligns with the hovered tile.

**Colorize module**: `colorize.ts` with two modes selected by `ColorValue.colorize?` flag. **Colorize mode** (Photoshop-style): grayscale → luminance → contrast → brightness → fixed HSL; always used for floor tiles. **Adjust mode** (default for furniture and character hue shifts): shifts original pixel HSL. `adjustSprite()` exported for character hue shifts. Cache keyed by arbitrary string (includes colorize flag).

**Floor tiles**: one 16×16 grayscale PNG per pattern (`floors/floor_N.png`, tile value = N + 1). Cached by (pattern, h, s, b, c). Pixels at alpha 254 are tall-grass foreground (see Office UI).

**Wall tiles**: `walls.png` (64×128, 4×4 grid of 16×32 pieces). 4-bit auto-tile bitmask (N=1, E=2, S=4, W=8). Sprites extend 16 px above tile (3D face). `wallTiles.ts` computes bitmask at render time. Colorizable via HSBC sliders. Wall sprites z-sorted with furniture/characters (`getWallInstances()` builds `FurnitureInstance[]`).

**Character sprites**: 6 pre-colored PNGs (`assets/characters/char_0.png`–`char_5.png`), one per palette. Each 112×96: 7 frames × 16 px wide, 3 direction rows × 32 px tall. Row 0 = down, Row 1 = up, Row 2 = right. Frame order: walk1, walk2, walk3, type1, type2, read1, read2. Left = flipped right at runtime. When `hueShift !== 0`, `hueShiftSprites()` applies `adjustSprite()` to all frames before caching.

**Load order**: `characterSpritesLoaded` → `floorTilesLoaded` → `wallTilesLoaded` → `furnitureAssetsLoaded` → `layoutLoaded`.

## Testing

Three tiers, each with its own framework.

### Server unit/integration (Vitest)

`server/__tests__/` covers the shared runtime, persistence, providers, HTTP/WebSocket server, CLI, diagnostics, asset reloads, and the e2e scenario runner. Representative suites include:

| File                                | Coverage                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentStateStore.test.ts`           | Mutations, EventEmitter events, snapshot                                                                                                       |
| `hookEventHandler.test.ts`          | Routing, buffering, normalized dispatch, team gating                                                                                           |
| `sessionRouter.test.ts`             | session_id mapping, pending sessions, buffer flush                                                                                             |
| `fileWatcherDismissal.test.ts`      | DismissalTracker integration                                                                                                                   |
| `fileStateAdapter.test.ts`          | Namespaced persistence, allowlist, settings round-trip                                                                                         |
| `migrateVsCodeState.test.ts`        | Verify-before-clear, partial migration                                                                                                         |
| `teamUtils.test.ts`                 | Inline-teammate helpers                                                                                                                        |
| `claudeTeamProvider.test.ts`        | Discovery, membership, metadata extraction                                                                                                     |
| `claude.test.ts`                    | `normalizeHookEvent` per Claude event, file fallback                                                                                           |
| `claudeHookInstaller.test.ts`       | Atomic install/uninstall, unparseable-file + non-array abort, throwing writes, mode preservation, backup, hook identity, event-scope migration |
| `consentFlow.test.ts`               | In-app consent over the wire: who is asked, what each answer writes, Back-and-revise semantics, answer serialization                           |
| `claude-hook.test.ts`               | Spawned hook script integration (needs `dist/hooks/claude-hook.js`)                                                                            |
| `server.test.ts`                    | HTTP lifecycle, auth, `/ws`, broadcast                                                                                                         |
| `httpServerWs.test.ts`              | `/ws` gate: standalone same-origin and Host gate (a rebound DNS name is refused), embedded Bearer                                              |
| `launchCodes.test.ts`               | `--open` launch codes: no token in argv, single use, Bearer to mint, Host gate on redeem                                                       |
| `conductorPollerScheduling.test.ts` | Conductor tiers and budget: Focus TTL and peers, catch-up polls, level wait, pinned and PC Box units                                           |
| `conductorHistory.test.ts`          | Chat history pages: cursors, keys shared with the detail, refusals                                                                             |
| `demoProvider.test.ts`              | `--demo` through the real stream driver: spawns, links, faint and revive, the question, evolution, user actions, determinism, no network       |
| `mockClaudeRunner.test.ts`          | E2E scenario runner sanity                                                                                                                     |

Run: `npm run test:server` (or `npm test` for all).

### Desktop helpers (node:test)

`desktop/test/` runs through `node --import tsx --test` without Electron: notification grace/quiet/dedupe/rate limit, withdrawals, the overflow summary and the badge count (`attention.test.ts`), window placement (`windowState.test.ts`), the navigation allowlist (`navigation.test.ts`), the menu (`menu.test.ts`: Close Window on macOS, Settings, Help, DevTools only unpackaged), reconnect feedback (`reconnect.test.ts`), the store and WebSocket feeds including a real office (`officeFeed.test.ts`), args, species names, the version pin, the copyright line, the Automation usage text and the Jukebox wiring, names shared with the webview and the Help anchor. `scripts/generate-icons.test.mjs` checks the .icns/.ico containers, that the art stays inside the rounded square, Promptling's face at every size (a `>` eye and a block-cursor eye, found by shape), that no size uses red, a pixel of tile around the body at 16 px, and that committed icon files match the generator.

Run: `npm run test:desktop` and `npm run test:icons` (both in `npm test`).

### Webview unit (Vitest, Node runner)

`webview-ui/test/` covers office state, layout editing and migration, assets, changelog behavior, and Vite/browser wiring.

Run: `npm run test:webview`.

### Package and docs contracts (node:test)

`npm run test:package-contract` (part of `npm test` and CI): `scripts/npm-package-contract.test.mjs` (package identity, tarball allowlist), `scripts/prepare.test.mjs` (the `prepare` plan, plus `prepare.mjs` run in throwaway repositories: missing build tools, a failing build, a fresh clone) and `scripts/docs-contract.test.mjs` (README flag, environment and data-file tables and defaults against the code, CLAUDE.md protocol counts against `core/asyncapi.yaml`, no "fork" wording, the upstream credit). Adding a CLI flag, an environment variable or a protocol message means updating README.md or CLAUDE.md in the same change.

### End-to-end (Playwright)

`e2e/` contains Playwright tests against a real VS Code Electron instance and a standalone Fastify server. CI runs only the standalone specs, on Linux at `--workers=1` with `POKE_AGENTS_SPRITES=off`; standalone specs must launch with `--no-conductor` so a developer's `CONDUCTOR_API_KEY` never adopts real sessions into a test office. The generated [e2e inventory](e2e/README.md) is the source of truth for current specs, scenarios, and `@area:` coverage.

**Running VS Code e2e locally needs explicit approval.** The VS Code specs (`e2e/tests/claude/**`) launch real VS Code windows one after another, which cover the screen and steal keyboard focus from whatever the user is typing in. Ask the user before running any of them, and when approved:

- Run them **once, at the end of an implementation** — never as an intermediate check.
- **Never from a subagent**: delegated work verifies with typecheck, lint, unit tests, and the standalone specs (`e2e/tests/standalone/**`, headless browser, no windows).

**Mock claude**: Tests never invoke real `claude`. A bash script (`e2e/fixtures/mock-claude`) is copied into an isolated `bin/` and prepended to `PATH`. The scenario runner (`mock-claude-runner.cjs`) honors `claudeScenario(...).at(ms).appendJsonl(record).emitHook(event).holdOpenFor(ms).build()` to drive timed JSONL writes and hook events.

**Authoring rules (normative)**: before writing a new spec, read `e2e/README.md` → "Mocking model & rules". It is the single source of truth for the process-boundary principle, the append-only transcript rule, the assert-on-visible-outcomes discipline, and the one standalone-server exception. New tests must follow that model.

**Isolation**: each test gets its own `tmpHome`, workspace directory, VS Code `--user-data-dir`, and mock-log file. No state leaks between tests.

**Auto-fixtures**: `_allureLabels` (auto: true) reads `@area:<tag>` from `testInfo.tags` and applies the corresponding Allure epic.

**Single source of truth for test inventory**: `e2e/README.md` contains an auto-generated section spliced between `<!-- BEGIN:E2E-INVENTORY -->` and `<!-- END:E2E-INVENTORY -->` markers. CI regenerates via `npm run e2e:inventory` and fails on `git diff --exit-code e2e/README.md`.

Run:

```bash
npm run e2e                                    # all tests
npm run e2e -- --workers=1                     # single worker (matches CI sharding)
npm run e2e -- --grep "lifecycle"              # filter by name
npm run e2e:debug                              # step-through
npm run e2e -- --attach-videos-on-success      # keep videos for passes too
npm run e2e:inventory                          # regen e2e/README.md inventory
npm run test:report                            # build combined Allure report
npm run test:report:open                       # serve Allure locally (file:// can't fetch)
```

**Reproducing CI failures locally**: CI uses `--workers=1` because the runners can't handle more. Reproduce locally with `npm run e2e -- --workers=1 --grep "<test>"`. For full Linux fidelity, `act -j linux-e2e --matrix shard:1 -P ubuntu-latest=catthehacker/ubuntu:full-22.04 --container-architecture linux/amd64` or run inside `mcr.microsoft.com/playwright:v1.58.2-noble` Docker with `--cpus=2 --memory=4g` to simulate runner throttling.

## Build & Dev

**npm workspaces monorepo** (`server`, `webview-ui`). A single `npm install` at the root installs deps for all workspaces; `cd webview-ui && npm install` is redundant.

```bash
npm install                # installs root + workspaces in one shot
npm run compile            # asyncapi:generate, check-types, lint, esbuild, vite
npm run build              # alias for compile
npm run package            # production build (esbuild --production)
npm test                   # webview + server vitest, package contract, desktop helpers, icons
npm run e2e                # Playwright
npm run app:mac            # Mac app: build:app, desktop npm ci, electron-builder (on a Mac)
npm run app:dev            # Mac app, unpackaged
npm run icons:generate     # redraw every icon file from scripts/generate-icons.mjs
```

`esbuild.js` runs three bundles:

1. **Extension** (`dist/extension.js`) from `adapters/vscode/extension.ts`. External: `vscode`.
2. **CLI** (`dist/cli.js`) from `server/src/cli.ts`. Externals pulled at install time (`fastify`, `@fastify/*`).
3. **Hook scripts** (`dist/hooks/claude-hook.js`) from `server/src/providers/hook/claude/hooks/claude-hook.ts`. CJS, shebang.

`define: { 'process.env.PIXEL_AGENTS_VERSION': JSON.stringify(version) }` stamps the package version into all bundles.

**Watch mode**:

```bash
npm run watch                       # parallel esbuild watch + tsc --noEmit watch
cd webview-ui && npm run dev        # Vite dev server (separate terminal)
```

The webview Vite dev server is **not** included in `npm run watch` — it has to be run separately.

**F5 in VS Code** launches the Extension Development Host with the local extension loaded.

### CI

`.github/workflows/ci.yml`, on pushes to `main` and PRs: the `ci` job (install with `POKE_AGENTS_SKIP_BUILD=1`, `asyncapi:validate`, `asyncapi:generate` + drift check, `e2e:inventory` + drift check, `check-types`, `lint`, `test:webview`, format check, knip (advisory), build, npm package contract + installed-tarball smoke, `test:server`, audit (advisory)), `npm-package-node20` (the same smoke on Node 20), and `standalone-e2e` (Linux, `e2e/tests/standalone`, `--workers=1`, sprites off). The `ci` job also runs `test:desktop` and `test:icons` (blocking); nothing builds the Mac app in CI. `required-checks` aggregates the three. Nothing publishes or deploys: upstream's Marketplace/npm publish workflow, badge cron, Dependabot and Vercel report previews are gone.

The drift checks are the central guarantees: `core/asyncapi.yaml` ↔ `core/src/messages.ts` stay in lockstep; `e2e/README.md` stays in sync with the spec list.

## TypeScript Constraints

- **No `enum`** (`erasableSyntaxOnly` in webview) — use `as const` objects (`TileType`, `CharacterState`, `Direction`, `EditTool`).
- **`import type`** required for type-only imports (`verbatimModuleSyntax` in webview; convention in extension).
- **`noUnusedLocals` / `noUnusedParameters`** — strict everywhere.
- **`.js` extensions** on all relative imports in extension + server (Node16 module resolution).
- **Module Node16, target ES2022** in the extension/server. **`erasableSyntaxOnly`, `verbatimModuleSyntax`, `noFallthroughCasesInSwitch`** in the webview.

## Constants Policy

All magic numbers and strings are centralized — never inline:

| Where                              | What lives there                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/constants.ts`          | All timing/scanning constants (`PERMISSION_TIMER_DELAY_MS`, `TEXT_IDLE_DELAY_MS`, scanner intervals) shared by extension and standalone |
| `adapters/vscode/constants.ts`     | VS Code-only IDs, command names, workspace state keys                                                                                   |
| `core/src/constants.ts`            | Protocol-level constants (e.g., transport state names)                                                                                  |
| `webview-ui/src/constants.ts`      | Webview magic numbers (grid, animation, rendering, camera, zoom, editor, game logic) + canvas overlay rgba strings                      |
| `webview-ui/src/index.css` `:root` | CSS custom properties (`--pixel-bg`, `--pixel-border`, `--pixel-accent`, ...) for React inline styles and CSS                           |
| `webview-ui/src/office/types.ts`   | Re-exports grid constants from `constants.ts` for convenience                                                                           |

## Error Handling

- **Try-catch with graceful degradation** — errors logged but never crash the extension.
- **Malformed JSONL lines** silently ignored (catch block in `processTranscriptLine`).
- **Missing assets** logged with warning, operation continues with null/fallback.
- No centralized error reporting or telemetry.

## Logging

Use `console.log`/`error`/`warn` with prefixed context:

- Extension: `[Pixel Agents]`, `[Extension]`
- Asset loading: `[AssetLoader]`
- Webview: `[Webview]`

## Condensed Lessons

- `fs.watch` unreliable on Windows — always pair with polling backup.
- Partial line buffering essential for append-only file reads (carry unterminated lines).
- Delay `agentToolDone` 300 ms to prevent React batching from hiding brief active states.
- **Idle detection** has two signals: (1) `system` + `subtype: "turn_duration"` — reliable for tool-using turns (~98%), emitted once per completed turn. (2) Text-idle timer (`TEXT_IDLE_DELAY_MS = 5 s`) — for text-only turns. Only starts when `hadToolsInTurn` is false; suppressed once `hadToolsInTurn` becomes true. Reset on new user prompt or `turn_duration`. Cancelled by ANY new JSONL data.
- User prompt `content` can be string (text) or array (tool_results) — handle both.
- `/clear` creates a NEW JSONL file (old file just stops).
- `--output-format stream-json` needs non-TTY stdin — can't use with VS Code terminals.
- Hook-based IPC failed in early prototypes (hooks captured at startup, env vars don't propagate). HTTP `/api/hooks/:providerId` with `~/.pixel-agents/server.json` discovery works.
- PNG→SpriteData: pngjs for RGBA buffer, alpha threshold 2 (`PNG_ALPHA_THRESHOLD`), supports `#RRGGBBAA` semi-transparent pixels.
- OfficeCanvas selection changes are imperative (`editorState.selectedFurnitureUid`); must call `onEditorSelectionChange()` to trigger React re-render for toolbar.
- **External-session adoption**: scanner runs every 3 s. In hooks-OFF mode external scenarios, the test setup can race the first scanner tick. Mock-claude scenarios should give a few seconds of margin before assertions.
- **Heuristic sub-agent permission bubble timing**: the bubble lands 7 s after the SUB-TOOL is registered, not 7 s after the parent Task tool appears. Tests waiting on it from the "Subtask:" overlay need at least `1 s (Task→Bash gap) + 7 s timer + ~300 ms IPC/render = 9–10 s` budget.
- **runInBackground sub-character gate**: in webview `agentToolStart`, `runInBackground=true` Agent tools are gated out of sub-character creation when the parent has a `teamName` (teammate path handles it). With no `teamName`, the gate must be bypassed so the basic Subtask sub-character still renders. `addSubagent` dedups via `subagentIdMap`, so the bypass is safe even if a teammate is detected later. `subagentToolStart` creates the sub lazily when it's missing — covering teamed leads' unnamed background spawns and post-reload recreation.
- **Allure HTML report**: viewing via `file://` fails (browsers block `fetch()` from local files). Use `npx allure open allure-report/allure` or `npm run test:report:open`.
- **Context usage is a snapshot against a provider-declared window**, and both halves are easy to get wrong: cumulative sums measure spend rather than occupancy, `input_tokens` without the cache counters measures almost nothing, and a 200k window assumed for a 1M model reads five times too full (the number to check it against is Claude Code's own statusline `context_window.used_percentage`).

## Manual Hook Testing

`server/manual-hook-events.http` (REST-Client format) drives the local hook server while the extension is running. Copy `port` and `token` from `~/.pixel-agents/server.json`, set `cwd` to a workspace folder opened in the Extension Development Host. Covers `SessionStart` → `PreToolUse` → `PermissionRequest`/`Notification`/`Stop` → `SessionEnd`.

If `cwd` is outside the current workspace, enable **Watch All Sessions** first.

## Asset Pipeline (legacy tileset import)

7-stage pipeline in `scripts/` for importing third-party tilesets (the bundled assets don't need this):

1. `0-import-tileset.ts` — Interactive CLI wrapper
2. `1-detect-assets.ts` — Flood-fill asset detection
3. `2-asset-editor.html` — Browser UI for position/bounds editing
4. `3-vision-inspect.ts` — Claude vision auto-metadata
5. `4-review-metadata.html` — Browser UI for metadata review
6. `5-export-assets.ts` — Export PNGs + `furniture-catalog.json`
7. `asset-manager.html` — Unified editor (stages 2+4 combined), Save/Save As via File System Access API

Supporting: `wall-tile-editor.html` (wall sprite editing), `jsonl-viewer.html` (transcript inspector).

## Key Decisions

- **Layered codebase** (core → server → adapters; core → webview-ui). Standalone CLI never imports `adapters/vscode/` and vice versa.
- **AsyncAPI 3.0 contract**, generated TS bindings, CI drift check. Single source of truth for the wire protocol.
- **AgentRuntime** shared lifecycle core, composed by both surfaces.
- **AgentStateStore** as single source of truth with typed mutations and typed events. No transport calls outside the broadcast layer.
- **Transport abstraction**: `MessageTransport` interface, `PostMessageTransport` + `WebSocketTransport`. One branching point in the entire UI.
- **HookProvider** as the integration boundary, with optional file fallback. New CLIs are a single subdirectory under `server/src/providers/hook/<id>/`.
- **StreamProvider** for sources without hooks (Conductor): the provider polls and pushes `AgentEvent`s into a `StreamAgentDriver` that reuses the existing broadcast shapes, so the webview stays provider-agnostic.
- **No Pokémon art in the repo, ever** — not in assets, tests, fixtures or docs. Sprites are downloaded at runtime to the user's own cache; tests use synthetic PNGs. What we draw ourselves (icons, the capsule, world art) is our own design, not a rendition or recolour of an official one.
- **TeamProvider** as optional extension. Claude Agent Teams is the only implementation.
- **Per-adapter namespaced persistence** under `~/.pixel-agents/`. VS Code and standalone never clobber each other.
- **Verify-before-clear migration** for legacy VS Code state.
- **Single `WebviewViewProvider`** (panel area, not editor area).
- **Inline esbuild problem matcher** (no extra extension needed).
- **`erasableSyntaxOnly`** in webview forbids `enum` — use `as const` objects.
- **Server always starts** regardless of hooks toggle. Only hook installation is gated by the setting.
- **Consent before any FIRST settings-file write**, per provider (`hooksConsent: {providerId: 'granted'|'declined'}`, absent = unanswered; the `hooksEnabled` preference beside it is per-provider and machine-global). **Exactly one population is asked: the one with nothing of ours installed** — hooks already on disk are granted silently at startup, since that install only ever removes events. The ask is one step of the Intro, the four-step first-run tour a greeter character speaks in-app on both surfaces (`IntroBubble.tsx`); the server sends `hooksConsentRequest` during the `webviewReady` handshake, one per provider, privileged connections only, carrying the provider's own `consentDisclosure()` so no client-side copy can drift. The ask-or-not predicate, the choice→action rule, and the execution live ONCE in `server/src/providers/hook/` (`consentGate.ts` decides, `consentExecutor.ts` performs); surfaces supply only their effects. **A choice is an absolute state command, not an event** — Back re-opens the ask, so a revision undoes whatever the earlier answer left: hooks on disk, a grant a failed install recorded, or a decline's own persisted hooks-off. That is why the consent record is a tri-state and each answer commits in ONE config write; the full rule and its rejected alternatives are `docs/adr/0001`. An abort (close x, Escape) sends nothing and the whole Intro returns next open; the closing step reports the install OUTCOME, not the click.
- **`hooksStatus` is install state, `hooksEnabled` is preference.** The Settings checkbox binds to `hooksInstalled` and toggles the _displayed_ state with no optimistic local update, so it can't read "on" over an untouched settings.json and lands correct rather than flickering when an install fails. Every failure path re-derives and broadcasts the truth (standalone via `clientMessageHandler`, VS Code via `reportHooksStatus`). The hook script is copied BEFORE the entries are written; a failed copy aborts the install (entries pointing at a missing script spawn a dead `node` per event). **Hooks-off is persisted only AFTER a successful uninstall** — flipping it first strands the user: the entries keep firing while the persisted preference makes the next start skip the gate entirely.
- **Never rewrite a shape we did not author.** The unparseable-file abort generalizes: a non-object `hooks`, a non-array `hooks.<Event>`, and junk entries inside an event array are all refused or passed through, never replaced. An array `hooks` was the sharp case — string keys assigned onto it vanish from `JSON.stringify`, so the write committed and reported `installed: true` over a file with no hooks in it. Emptied event keys are deleted only when _our_ removal emptied them. **Internal sentinels must not be values user JSON can hold**: `null` marked "this entry is now empty", so a user-authored `null` inside a hooks array was silently deleted (a file with no Pixel Agents command anywhere came back rewritten and logged as "Hooks removed") — it is a `Symbol` now.
- **Hook identity is anchored at both ends, not a substring.** `includes('claude-hook.js') && includes('.pixel-agents')` claimed — and `uninstallHooks` then DELETED — a `.backup` copy of our script, a shell comment naming our path, a wrapper passing it as an argument, `/opt/evil.pixel-agents/hooks/claude-hook.js`, and `my-pixel-agents-hook.js`. Ours = the `/.pixel-agents/hooks/claude-hook.js` suffix, ending the command's FIRST token, matched **case-insensitively** (the token is normalized to lower case). Case-sensitive matching is what shipped, and on the case-insensitive volumes this runs on (macOS, Windows) a differently-cased path is the SAME INODE as our script and genuinely firing: reinstall appended a duplicate and uninstall left the cased entry as an orphan our own `areHooksInstalled` could no longer see — a live hook with no removal route. The folding is unconditional (no filesystem case-sensitivity probe), so the accepted trade is a Linux-only false positive that is **not** a mere dedup: on a case-sensitive volume `~/.Pixel-Agents/hooks/claude-hook.js` is a genuinely DIFFERENT file, we classify it as ours, and uninstall **deletes** it (`claudeHookInstaller.test.ts` pins that removal). Nothing creates that path, and the trade is deliberate — the alternative is a guaranteed unremovable live hook on the two platforms this actually ships to. A symlink alias to our script is deliberately _not_ recognized — the cost is one duplicate entry, versus deleting a stranger's hook if we resolved paths.
- **E2E over webview unit tests** for OSS friction. Community PRs change webview internals constantly; unit tests would force contributors to update internals tests on top of feature work. E2E pins user-facing behavior, which is stable across internal refactors.

## Project Identity

- Product: **Poke Agents**, inspired by and based on [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) (Pablo De Lucca, MIT). Its own repository, not a GitHub fork.
- GitHub: `https://github.com/joshle298/poke-agents`
- npm package: `@joshle298/poke-agents` (CLI bin: `poke-agents`), not published; installed from GitHub. The unscoped `poke-agents` npm name belongs to an unrelated package.
- Version line: `0.2.x` (upstream history in `CHANGELOG.md` below the Poke Agents entries)
- VS Code extension ID unchanged (`pablodelucca.pixel-agents`, `pixel-agents.*` command/view IDs); not published by Poke Agents
- License: MIT (`LICENSE` keeps the upstream copyright line)
