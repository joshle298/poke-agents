# Changelog

## Poke Agents (unreleased)

### Features

- **Switch model…** in the Pokédex. Conductor's API can't change the model of a running session, so this starts a new session in the same workspace (same files and branch) instead: pick Claude, Codex or Cursor, a model (your Conductor favorites first, starred), an effort and fast mode where the model has it, and edit the first message, which starts as a note to continue the work and check the recent commits and changes. The new session is named after the original and the model, thrown out of the original Pokémon and linked to it, and its Pokédex opens when it walks in. The original session isn't changed and doesn't become a Lead (nor get a LEAD badge in Sessions); while it is still working, the picker says so and offers **Stop it**. A create whose answer was lost is retried with the same session and message ids, Poke Agents then asks Conductor whether the session exists, and starting again with the same choice reuses those ids, so Conductor makes it once. Effort levels only some models take say "(some models)". The demo plays it against its own sessions.
- **Change Pokémon…** in the Pokédex's header: choose a session's evolution line (a Lead can also be a legendary) from a grid of portraits, turn Shiny on or off (at once), or reset it to the Pokémon it had before. The level still picks the stage within the line, the change plays the evolution flash, and the choice is kept across restarts and never replaced by a Lead's legendary. It is Poke Agents' own view; Conductor isn't told.
- The Pokédex's Overview shows the session's agent, model and effort (and fast mode), with the model's name from the catalog.
- Dialogs are announced as dialogs, take focus when they open and give it back when they close; checkboxes state whether they are checked; the Pokédex's and Switch model's tabs work with the arrow keys.

### Changes

- **Calm desks.** A Pokémon at work breathes at its desk instead of shaking: no looping power-up shiver, and a tool start, a message or a turn end plays at most one short gesture every 6 seconds.
- **Asleep means asleep.** The office and the party bar decide `SLP` with one rule (done or idle, no activity for two minutes), so they always agree; an asleep Pokémon lies still with a Zzz until something wakes it.
- **Only Pokémon.** With the Pokémon theme on, no Pixel Agents person appears any more: a session whose sprites are still loading waits as a closed capsule that opens when they arrive, one whose sprites can't load stays a capsule ("Sprite unavailable"), sub-agents are their parent's Pokémon, and the first-run greeter is Promptling.
- A new app icon: the Poke Agents capsule, a teal cap and a cream body, with a bold gold C for Conductor in place of its collar, replacing Promptling in the Mac app, the favicon and the installed web app. At 16 and 48 px it shows a dark C on a gold collar.
- The browser and installed web app's window colour is the office's night blue instead of red, to match the icon.

## Poke Agents v0.3.1

Connect to Conductor from inside the app.

### Features

- **Connect to Conductor in the office.** Without a Conductor key, the office (and the Mac app) shows a **Connect to Conductor** card instead of telling you to run `conductor auth login` in Terminal, which usually isn't on your `PATH`. **Get an API key** opens Conductor's API keys page in your browser; paste the key (or click **Paste**) and click **Connect**. Poke Agents checks it with Conductor and your sessions walk in without restarting the office or reloading the page. On macOS the key is kept in Poke Agents' own Keychain item (`com.joshle298.pokeagents.conductor`), never in the Conductor CLI's. Apps you run can read that item without a prompt, as they could read an environment variable. On Linux and Windows the key lasts until the office stops. In the Mac app, coming back from the browser with a Conductor key copied offers **Use key from clipboard**, which shows the key's prefix and last four characters and fills the field; nothing is sent until you click **Connect**.
- **Settings → Conductor** shows the account, where the key came from (`CONDUCTOR_API_KEY` or `CONDUCTOR_API_TOKEN`, Poke Agents' Keychain item, the Conductor CLI, or memory until Poke Agents quits) and **Sign Out of Conductor…** for a key Poke Agents saved. Signing out never touches the Conductor CLI's sign-in; if the CLI is signed in, the office switches to it and says so.

### Changes

- Keys are looked up in this order: `CONDUCTOR_API_KEY`, `CONDUCTOR_API_TOKEN`, the key connected in the office, then the Conductor CLI's Keychain sign-in.
- **Reconnect to Conductor** in the Mac app restarts Conductor polling inside the office instead of restarting the whole office, so the window keeps its page.
- The card's **Prefer the CLI?** gives the full path of the Conductor CLI inside the Conductor app.
- Status lines no longer tell you to set `CONDUCTOR_API_KEY` and restart, except when the rejected key comes from an environment variable, which they name.

## Poke Agents v0.3.0

The Pokémon release. Poke Agents shows your Conductor cloud sessions as Pokémon in a small pixel-art town, as a Mac app or in a browser window next to Conductor. It is a visualizer: all coding happens in Conductor with your Conductor settings, and Poke Agents only asks Conductor's API to act when you click.

With this release, Poke Agents has:

- **The town:** working sessions at the Lab's desks (Leads at the lectern), idle ones wandering and napping in the Meadow's tall grass, fainted ones in the Pokémon Center's beds.
- **A Pokémon per session** that keeps its species, levels up with the session's messages, evolves at Lv 16 and Lv 36, and shows `SLP`, `FNT` or `!`. Leads are legendaries, linked to the sessions they created, messaged or read, and messages fly between sessions as capsules with a preview.
- **The Pokédex:** Overview (task, status, HP for the context left, recent tool steps, messages with other sessions and the session actions) and Chat (the conversation, **Load earlier**, a reply box, and pending questions with **Reply with this option**).
- **PC Box** for archived sessions, the **Sessions** modal for scope, activity window, cap, search, hide and pin, the **party bar** and the **battle log**.
- **Sounds:** each Pokémon's cry, downloaded at runtime, and original chiptune effects.
- **Jukebox** with **Poke Agents Radio**, 12 freely licensed original tracks, plus your own music.
- **The Mac app**, with notifications and a Dock badge, and **demo mode** for trying it without a Conductor account.
- **Promptling**, an original mascot, as the app icon, and an original capsule.

### Features

- **Mac app:** `npm run app:mac` builds Poke Agents as a macOS app: the office in its own window, notifications when a session needs you or faints, and a Dock badge counting the sessions waiting on you.
- **Demo mode.** `npm run demo` (`poke-agents --demo`) plays a scripted story with synthetic sessions instead of connecting to Conductor, so you can try Poke Agents without a Conductor account: a Lead spawns five sessions that work, message it, level up, faint and get revived, fall asleep, wait on a question and evolve. Every action in the office works on the demo's sessions, and nothing reaches Conductor. The first round is the same on every run (for screenshots); `--demo-seed` and `--demo-speed` (or `POKE_AGENTS_DEMO_SPEED`) vary it. The Mac app takes `--demo` too.
- **Sounds.** Each Pokémon's official cry (downloaded at runtime from the PokéAPI cries project to `~/.pixel-agents/cache/cries/`, never bundled) when its session needs you, faints, arrives or evolves, plus original chiptune effects for level-ups, evolutions, capsules, messages and recalls. Rate-limited and quiet after a reconnect; **Settings → Sound** has volume, Cries / Alerts / Effects toggles and a test button per sound, and files in `~/.pixel-agents/sounds/` replace the effects.
- **The Pokémon Town.** A new office opens on a small town in a forest, drawn in code (`scripts/generate-world-assets.mjs`): working sessions sit at the desks in the Lab (Leads at the lectern), idle ones wander and nap in the Meadow's tall grass and around the pond, and fainted ones lie tucked into the Pokémon Center's beds until revived. **Layout → Templates** switches between the town and the classic office; Undo switches back. An office with a saved layout keeps it.
- **Poke Agents Radio.** The Jukebox's built-in station, and its first tab: 12 original chiptune and retro RPG tracks (town, route, indoors, a calm night, a battle) that their authors released under CC0 or CC BY, credited in Settings → About & credits and the README. Shuffle all, play in order or pick a track. Each track downloads once from its author's page (`opengameart.org`, `incompetech.com`) into `~/.pixel-agents/cache/music/radio/` and plays only if it matches its pinned SHA-256; louder tracks are turned down so the station keeps one volume. No audio is in the repository.
- **Jukebox.** Background music from music you already have: audio files in `~/.pixel-agents/music/`, or albums and links you play in the Music or Spotify app on macOS (the Mac app asks once for permission to control them). Open it from ♪ in the toolbar or **Jukebox…** under Settings → Sound. Pokémon cries and alerts briefly lower radio and folder music. It never downloads, streams or bundles game soundtracks.

### Fixes

- A working session with no tool running reads **Working** on its label instead of Idle.
- Fainted Pokémon turn grey instead of a muddy brown.
- A party slot whose name doesn't fit keeps the end of it in view ("recorder-pl…review-1"), so sessions that share a prefix stay apart.
- A Lead's links start at the Lead, not at the chair under it.
- **A Lead's children stay put.** A Lead with more than 12 children no longer swaps them in and out of the office as their activity re-ranks: a shown child stays until it falls 4 places past the cap.

### Changes

- A new app icon: Promptling, an original pixel mascot (a round teal creature whose eyes are a `>` prompt and a block cursor), drawn in code by `scripts/generate-icons.mjs` for the Mac app, the favicon and the installed web app.
- Sessions are thrown out of, recalled into and messaged as an original capsule (a teal-and-cream pill with a gold collar that opens by pulling its halves apart) instead of a red-and-white ball. The PC Box and the empty office show the same capsule when there is no portrait.
- New flag `--no-sounds` (or `POKE_AGENTS_SOUNDS=off`): no cry or radio downloads and no sound pack.
- New flag `--no-radio` (or `POKE_AGENTS_RADIO=off`): Poke Agents Radio off, no track downloads.
- The README is rewritten around the town, with screenshots from the demo in `docs/screenshots/`; its Credits name the species and sprite artists in them. Upstream Pixel Agents' documentation is now a link, and the Mac app checklist moved to CONTRIBUTING.md.
- The Mac app's About panel and Info.plist say "Based on Pixel Agents by Pablo De Lucca", replacing the old fork wording.
- Upstream's unused README images (`banner.png`, `office.png`, `characters.png`, `Screenshot.jpg`) are gone from `webview-ui/public/`.

## Poke Agents v0.2.0

A polish pass from running the office against real Conductor sessions. Poke Agents is still only a visualizer: every new action asks Conductor's API, on your click.

### Features

- **Chat tab in the Pokédex.** The session's conversation as a scrollable thread: your messages, the agent's replies, each turn's tool steps folded into one line, and messages to and from other sessions. **Load earlier** pages back through older messages, fetched from Conductor on demand within the request budget. Reply from the box at the bottom (Enter sends, Shift+Enter starts a new line; on a phone, Send sends); the box shows when a reply is sending and whether Conductor accepted it. Markdown links show as their text, and nothing is rendered as HTML. A view-only office (no token) doesn't load conversations.
- **Pending questions.** When a session waits on a question (Claude's AskUserQuestion, a plan to approve, or a Codex question), the Chat tab shows the question and its options, and Overview offers **Answer in Chat**. **Reply with this option** sends the option's text as a normal message.
- **Real levels on arrival.** A session walks in once its message count is read, at its real level and with its last activity time, so it no longer appears at Lv 1 and then "evolves" when you open its Pokédex. Idle sessions fall asleep as they should.
- **Tool names in the Pokédex.** Recent tool steps read "Bash · 41s" instead of "Used · 41s".
- **PC Box portraits.** Archived sessions show their Pokémon's portrait after a reload or a restart, not only when this page saw them in the office.
- **`--claude` agents level up.** Claude Code agents gain levels from their tool calls and keep them across restarts.
- **About.** Settings → **About & credits** says what Poke Agents is and credits Pixel Agents and the sprite artists.

### Fixes

- **Privacy: DNS rebinding.** The office's live connection is refused under host names other than `localhost`, IP addresses, `--host` and `--allowed-host`. Before, a web page that pointed its own domain at your computer could open a read-only connection on port 41510 and read your session list and message previews. A LAN viewer that uses a name like `my-mac.local` now needs `--allowed-host my-mac.local`; the office says so instead of reconnecting forever.
- **Privacy: the token stays off command lines.** `--open` and `npm start` open a one-time link that the office swaps for the tokened URL, so the token never appears in the browser's command line.
- **Sprites:** other web sites can no longer make the office download sprites, and only species the office can show are served. A species that failed to download is retried while a Pokémon still needs it.
- **Withdraw from the PC Box** keeps the session in the office and the lists even when its last activity is older than the activity window. Before, it vanished from both.
- **The PC Box fills while the office is busy.** Opening it lists the deposits in your most recently active workspaces within seconds. Before, on a busy request budget, those listings could wait behind steady polls indefinitely and the PC Box stayed empty.
- **"All" in the Sessions modal** really widens the window (to the last 30 days, shown as **All (30d)**). Before, it narrowed it to 1 hour.
- **Smoother polling.** Closing the Pokédex releases its session from the fastest polling tier within about 10 seconds; it no longer keeps it and every linked session polled every few seconds for the rest of the run. Selecting a Lead no longer slows the Lead itself down, a busy workspace no longer keeps its idle sessions on the fast tier, and one rate-limit reply halves the request rate once instead of once per request in flight.
- **Short turns show.** A turn that starts and finishes between two polls still shows a brief working burst and the turn-end hop.
- **No chime on startup** for sessions that were already waiting on you; they still show `!`.
- **Seats:** sessions keep their desk across restarts, even before they walk back in.
- **A session that leaves and comes back during its recall** reappears instead of vanishing until a reload.
- **A spawned session's name** shows once on its label.
- **Escape** closes the window on top, one at a time: a confirmation, then an open modal such as Sessions or Settings, then the Pokédex. Before, Escape closed the Pokédex hidden under an open modal and left the modal up.
- **Enter that confirms an IME composition** no longer sends the message.
- **Memory:** sprites of species nobody has shown for 5 minutes are released.
- **One office polls Conductor.** A second office on the same machine (another mode) runs without Conductor and says which office has it, instead of doubling the API traffic and overwriting the first one's state.
- **First install.** `npm ci` says when it builds `dist/`, how long the build took and to run `npm start` next. Installing without devDependencies (`--omit=dev`, `NODE_ENV=production`) stops with the command that fixes it instead of a stack trace. With no Conductor sign-in, the terminal now says how to sign in, a failed `--open` prints one line, and a first run no longer shows "Updated to v0.1!".

### Changes

- Poke Agents is its own project, inspired by and based on Pixel Agents by Pablo De Lucca. The license keeps the upstream copyright notice.
- The README says what Poke Agents reads from Conductor, what it can ask Conductor to do, and what it never does.
- `conductor-state.json` is written less often and drops sessions nothing touched for 30 days.

## Poke Agents v0.1.0

First release of Poke Agents, inspired by and based on Pixel Agents, showing [Conductor](https://conductor.build) cloud sessions as Pokémon.

### Features

- **Conductor sessions in the office.** Cloud sessions are polled from Conductor's public API and appear live, each as a Pokémon that keeps its species. They work while a session runs tools, sleep after a while idle, faint on an error and show `!` when they need you.
- **Levels and evolution.** `Lv` grows with session activity, with evolution at Lv 16 and Lv 36 when a line has later stages.
- **Leads and links.** A session that created other sessions is a Lead and appears as a legendary. Lines connect sessions that created, messaged or read each other, and messages fly between them as Poké Balls with a short preview.
- **Pokédex panel** with the session's task, recent replies and messages, and the actions Open in Conductor, Send message, Revive, Stop, Deposit in PC, Hide and Pin.
- **PC Box** for archived sessions, with Withdraw to bring one back.
- **Sessions modal** for scope (your workspaces or the organization), activity window, idle sessions, cap, search, hide and pin.
- **Party bar**, an optional **battle log**, and **Settings → Credits** for the sprite artists.
- **Desktop window:** `npm start` (`poke-agents --open`) opens the office in a Chromium app window, on fixed port 41510 so an installed web app keeps working.

### Changes

- The package is `@joshle298/poke-agents` and the command is `poke-agents`. Install it from GitHub (clone and `npm start`, or `npx github:joshle298/poke-agents --open`); it is not published to npm.
- Conductor is on by default (`--no-conductor` turns it off). Claude Code tracking is opt-in with `--claude`.
- New flags: `--open`/`--app`, `--browser`, `--claude`, `--no-conductor`, `--conductor-budget`, `--no-sprites`.
- Turning the Pokémon theme off in Settings restores the Pixel Agents look and stops sprite downloads.
- No Pokémon artwork is in the repository: sprites are downloaded at runtime from the PMD Sprite Repository to `~/.pixel-agents/cache/pmd/`.

## Pixel Agents (upstream)

The entries below are the upstream [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) releases by Pablo De Lucca and its contributors, which Poke Agents builds on.

## v1.5.0

### Features

- **Embedded terminal in the browser** ([#347](https://github.com/pixel-agents-hq/pixel-agents/pull/347)) — `npx pixel-agents` is now a full surface: **+ Agent** launches Claude Code in a server-side terminal that streams into a drawer beside the office, so you can launch, watch, type into and close agents without VS Code. Terminals outlive the page, so a reload reattaches to the running session with its current screen. Pass `--no-terminal` to keep the office watch-only.
- **Mobile web app** ([#404](https://github.com/pixel-agents-hq/pixel-agents/pull/404)) — On a phone the standalone office becomes a home-screen web app: office and terminal as two pages you swipe between, a bar of agent cards, touch gestures on the office, touch scrolling and long-press selection in the terminal, and an accessory key bar above the keyboard (esc, shift+tab, paste, a trackpad key).
- **Agent cards in VS Code** ([#404](https://github.com/pixel-agents-hq/pixel-agents/pull/404)) — Every agent gets a mug shot and status dot along the office's right edge; clicking one raises its terminal and selects the character.
- **Directories** ([#405](https://github.com/pixel-agents-hq/pixel-agents/pull/405)) — **+ Agent** opens a drawer of Directories to launch into, on both hosts: your workspace folders (or the directory the CLI started in) plus your own, each with a name, a path and optionally the Areas its agents should sit in. Paths are suggested from your past Claude Code sessions. The host's own Directories are listed only when **Show Workspace Folders** (VS Code) or **Show Start Directory** (standalone) is on in Settings; both are off by default.
- **Layout editor upgrades** ([#426](https://github.com/pixel-agents-hq/pixel-agents/pull/426)) — Alt+drag drops a copy; desks carry the items standing on them when moved, rotated or copied; Erase removes furniture it passes over; each floor, wall or erase stroke is one undo step; the colour sliders gain an eyedropper, and selecting a placed item opens its colours directly.

### Changes

- **Skip permissions is a setting** ([#405](https://github.com/pixel-agents-hq/pixel-agents/pull/405)) — Launching with `--dangerously-skip-permissions` is no longer chosen per launch: a **Settings** toggle (off by default) applies it to every launch, including auto-spawned agents.
- **Standalone access token** ([#347](https://github.com/pixel-agents-hq/pixel-agents/pull/347)) — The standalone URL carries a `?token=` that is now kept across restarts in `~/.pixel-agents/standalone-token`, so bookmarks and home-screen apps keep working. Launching, terminals and hook installs need it; a browser without it can only watch. Treat the URL as a secret. `--rotate-token` replaces it, and `--allowed-host` admits a reverse proxy's hostname (such as Tailscale Serve).
- Agents restored from v1.4.x keep their labels and Area assignments.

### Maintenance

- `@vscode/test-electron` 3.1 so the VS Code e2e tests launch the renamed macOS binary ([#428](https://github.com/pixel-agents-hq/pixel-agents/pull/428)).

### Contributors

Thank you to the contributors who made this release possible:

- [@pablodelucca](https://github.com/pablodelucca) — Embedded terminal, mobile web app, agent cards, Directories, and layout editor upgrades

## v1.4.1

### Features

- **Render headless agents as ghosts** ([#369](https://github.com/pixel-agents-hq/pixel-agents/pull/369)) — Agents adopted from outside the office (`claude -p`, Watch All Sessions) have no terminal to focus; a new **Display Headless as Ghosts** setting renders them translucent so they read differently from clickable agents. Off by default.

### Fixes

- **Never overwrite user settings** ([#378](https://github.com/pixel-agents-hq/pixel-agents/pull/378)) — The hook installer now aborts instead of rewriting `~/.claude/settings.json` when the file is unparseable or holds shapes it did not author, takes a one-time backup before the first write, verifies every write, and serializes consent answers. Closes [#377](https://github.com/pixel-agents-hq/pixel-agents/issues/377).
- **Sync agent state on standalone webview connect** ([#371](https://github.com/pixel-agents-hq/pixel-agents/pull/371)) — A standalone browser client that connects while agents are mid-work now receives active tool statuses, waiting status, and team metadata instead of showing every agent as idle until its next update.
- **Consistent palette and hue for every client** ([#370](https://github.com/pixel-agents-hq/pixel-agents/pull/370)) — Character palette and hue shift are now assigned server-side at agent creation, so every connecting webview (including read-only viewers) sees the same colors instead of each connection rolling its own.

### Maintenance

- Dependency updates: Vitest 4, ESLint 10, and GitHub Actions bumps, with the accompanying test and lint fixes.

### Contributors

Thank you to the contributors who made this release possible:

- [@giawa](https://github.com/giawa) — Standalone connect state sync and server-side palette assignment
- [@pablodelucca](https://github.com/pablodelucca) — Merge-safe hook installer and headless-agent ghosts
- [@florintimbuc](https://github.com/florintimbuc) — Merge-safe hook installer review and fixes

## v1.4.0

### Features

- **Claude Code Agent Teams visualization** ([#218](https://github.com/pixel-agents-hq/pixel-agents/pull/218)) — Renders team leads and teammates as coordinated characters in both tmux and inline modes, with role labels, lead badges, token fuel gauges, tool activity, persistence, and coordinated cleanup. Builds on the early implementations in [#79](https://github.com/pixel-agents-hq/pixel-agents/pull/79) and [#177](https://github.com/pixel-agents-hq/pixel-agents/pull/177). Closes [#65](https://github.com/pixel-agents-hq/pixel-agents/issues/65).
- **Claude Code sub-agents and teammates compatible up to v2.1.220** ([#351](https://github.com/pixel-agents-hq/pixel-agents/pull/351)) — Supports the newer Claude harness, where every `Agent` spawn runs in the background against an implicit per-session team. Named spawns become seated teammate characters with their own hook routing; unnamed spawns stay Subtask sub-agents whose transcripts are watched for live tool activity. Resumed leads re-latch to their newest team instead of stranding departed teammates or showing a phantom lead, and teammates take the free seat closest to their lead.
- **Context gauge on every agent** ([#351](https://github.com/pixel-agents-hq/pixel-agents/pull/351)) — Shows each agent's context occupancy above its character, sized to the context window of the model that session actually runs.
- **Animated pets** ([#315](https://github.com/pixel-agents-hq/pixel-agents/pull/315)) — Adds Claudio and Gitcat to the layout editor, autonomous walking and idle animations, petting interactions, saved placement, and custom pets loaded from external asset directories. Reimplements and supersedes [#219](https://github.com/pixel-agents-hq/pixel-agents/pull/219) on the new architecture.
- **Carpets and workspace Areas** ([#316](https://github.com/pixel-agents-hq/pixel-agents/pull/316)) — Adds three auto-tiling carpet styles with WYSIWYG color controls, paint/erase/eyedropper tools, undo, and persistence. Named Areas can be painted onto the office, mapped to workspace folders, and used to seat agents in the right part of the layout. Integrates the original carpet work from [#213](https://github.com/pixel-agents-hq/pixel-agents/pull/213) and Areas work from [#259](https://github.com/pixel-agents-hq/pixel-agents/pull/259).
- **Optional startup automation** ([#221](https://github.com/pixel-agents-hq/pixel-agents/pull/221)) — Adds `pixel-agents.autoShowPanel` and `pixel-agents.autoSpawnAgent` settings to open the panel and launch an agent automatically when VS Code starts. Both remain off by default.

### Standalone and Architecture

- **Layered architecture and provider-ready core** ([#236](https://github.com/pixel-agents-hq/pixel-agents/pull/236), [#238](https://github.com/pixel-agents-hq/pixel-agents/pull/238), [#273](https://github.com/pixel-agents-hq/pixel-agents/pull/273), merged through [#275](https://github.com/pixel-agents-hq/pixel-agents/pull/275)) — Separates shared contracts, the runtime server, the VS Code adapter, and the webview; centralizes lifecycle state in `AgentRuntime` and `AgentStateStore`; and removes runtime VS Code dependencies from the server. Provider, adapter, transport, and state interfaces now give future clients and agent providers stable integration points.
- **Standalone browser app and npm package** ([#273](https://github.com/pixel-agents-hq/pixel-agents/pull/273), [#344](https://github.com/pixel-agents-hq/pixel-agents/pull/344)) — `npx pixel-agents` starts a local Fastify server and browser office with WebSocket state delivery. The standalone UI now covers the core VS Code experience, including settings, diagnostics, asset reloads, layout import/export, Areas, carpets, and pets, while user state is centralized under `~/.pixel-agents/`. Closes [#120](https://github.com/pixel-agents-hq/pixel-agents/issues/120).
- **Multi-server hook discovery and fan-out** ([#344](https://github.com/pixel-agents-hq/pixel-agents/pull/344)) — Lets the VS Code extension and one or more standalone servers run together. Each server registers independently, Claude hook events fan out to every live server, and each surface adopts only the sessions in its configured scope.
- **Published WebSocket protocol contract** ([#273](https://github.com/pixel-agents-hq/pixel-agents/pull/273)) — Makes `core/asyncapi.yaml` the authoritative AsyncAPI contract and generates the shared TypeScript message bindings with CI drift detection.

### Fixes

- **Agent and teammate lifecycle reliability** ([#287](https://github.com/pixel-agents-hq/pixel-agents/pull/287), [#344](https://github.com/pixel-agents-hq/pixel-agents/pull/344)) — Fixes idle/done state regressions, aligns teammate lifecycle behavior, and preserves agent tracking when terminals move between VS Code locations.
- **Standalone server and development reliability** ([#316](https://github.com/pixel-agents-hq/pixel-agents/pull/316), [#344](https://github.com/pixel-agents-hq/pixel-agents/pull/344)) — Honors an explicit `--port`, restores browser-mock hot reload, adds connection-state feedback, and fixes Windows e2e startup behavior.
- **Areas editor and seating polish** ([#316](https://github.com/pixel-agents-hq/pixel-agents/pull/316)) — Correctly seats agents from custom-named workspace folders, fits four Area cards per row, and prevents the folder picker from being clipped.
- **File watching and session adoption** ([#352](https://github.com/pixel-agents-hq/pixel-agents/pull/352)) — Fixes duplicate agent adoption on Windows, where case-sensitive path comparison let the same session be adopted twice, and closes a `/clear` race in which the external scanner could adopt a replacement transcript before `SessionStart` reassigned it.
- **Hook install failures and restored-agent rendering** ([#351](https://github.com/pixel-agents-hq/pixel-agents/pull/351)) — Hook installation now reports failure instead of logging false success, and restored agents render regardless of the order in which `layoutLoaded` and `existingAgents` arrive. Closes [#333](https://github.com/pixel-agents-hq/pixel-agents/issues/333), [#334](https://github.com/pixel-agents-hq/pixel-agents/issues/334).
- **Standalone rendering of already-running agents** ([#349](https://github.com/pixel-agents-hq/pixel-agents/pull/349)) — Sends `layoutLoaded` after `existingAgents` on `webviewReady`, so a standalone client that connects once agents already exist renders their characters instead of an empty office.
- **Workspace transcript discovery with hooks enabled** ([#330](https://github.com/pixel-agents-hq/pixel-agents/pull/330)) — Keeps workspace JSONL discovery active when hooks are installed, so sessions are still found by file path rather than relying on hook delivery alone.
- **Cross-platform build and server tests** ([#289](https://github.com/pixel-agents-hq/pixel-agents/pull/289)) — Fixes `npm run build` failing outright on Windows for paths containing spaces, and server tests that bypassed temp-home isolation and wrote to the real `~/.pixel-agents`.

### Testing and Release Infrastructure

- **Comprehensive Playwright e2e suite** ([#287](https://github.com/pixel-agents-hq/pixel-agents/pull/287), [#344](https://github.com/pixel-agents-hq/pixel-agents/pull/344)) — Expands coverage across VS Code and standalone, hooks-on and hooks-off lifecycles, Agent Teams, pets, carpets, Areas, and multi-server behavior. Adds a deterministic mock Claude process, narrated run videos, an in-repo coverage inventory, and combined Allure reporting.
- **Verified npm publishing pipeline** ([#344](https://github.com/pixel-agents-hq/pixel-agents/pull/344)) — Adds package-contract tests, installed-tarball smoke verification, release tag/version checks, and provenance-ready npm publishing for the standalone package.
- **CI gating and platform coverage** ([#352](https://github.com/pixel-agents-hq/pixel-agents/pull/352)) — Adds a single aggregate `Required Checks` job so branch protection can gate on one stable check instead of every shard name, and unblocks the e2e suite on macOS Tahoe by making video recording optional.

### Maintenance

- **Move project links to `pixel-agents-hq`** ([#274](https://github.com/pixel-agents-hq/pixel-agents/pull/274)) — Updates repository, issue, and community links after the GitHub organization migration.
- Dependency and release-action updates ([#224](https://github.com/pixel-agents-hq/pixel-agents/pull/224), [#225](https://github.com/pixel-agents-hq/pixel-agents/pull/225), [#226](https://github.com/pixel-agents-hq/pixel-agents/pull/226), [#227](https://github.com/pixel-agents-hq/pixel-agents/pull/227))

### Contributors

Thank you to the contributors who made this release possible:

- [@itsManeka](https://github.com/itsManeka) — Animated pet system, bundled pet sprites, and pet interactions
- [@NNTin](https://github.com/NNTin) — Carpet system and foundational Playwright e2e infrastructure
- [@balgaly](https://github.com/balgaly) — Automatic panel display and agent startup settings
- [@elietwd](https://github.com/elietwd) — Cross-platform Windows build script and server test isolation
- [@snvtac](https://github.com/snvtac) — Workspace JSONL discovery with hooks enabled
- [@bezzborodth-tech](https://github.com/bezzborodth-tech) — Standalone rendering fix for agents that already exist on connect
- [@srasantos](https://github.com/srasantos) — Reported the hook-install and restored-agent rendering bugs
- [@ErickGross-19](https://github.com/ErickGross-19), [@ZenidX](https://github.com/ZenidX) — Early Agent Teams implementations that informed the shipped design
- [@pablodelucca](https://github.com/pablodelucca) — Claude 2.1.220 sub-agent and teammate support, context gauge, Workspace Areas, layout-editor polish, and watchable narrated e2e review
- [@modtanoii](https://github.com/modtanoii) — Architecture refactor collaboration, server and WebSocket design, and extensibility hardening
- [@florintimbuc](https://github.com/florintimbuc) — Architecture refactor, Agent Teams integration, standalone and npm package, multi-server support, file-watcher and CI hardening, e2e expansion, and release coordination

### Community acknowledgements

#### Architecture and standalone direction

Earlier standalone implementations from [@rollecode](https://github.com/rollecode) ([#156](https://github.com/pixel-agents-hq/pixel-agents/pull/156)), [@MikaelDDavidd](https://github.com/MikaelDDavidd) ([#166](https://github.com/pixel-agents-hq/pixel-agents/pull/166)), and [@TimpiaAI](https://github.com/TimpiaAI) ([#63](https://github.com/pixel-agents-hq/pixel-agents/pull/63)) demonstrated community demand and validated the browser SPA, WebSocket, and server discovery direction. These PRs were closed as superseded, with many thanks to their authors.

#### Independent fixes

Several community PRs independently diagnosed or fixed issues resolved in v1.4.0. Some overlapped with the final implementation, but each helped validate and strengthen the release:

- **Standalone hook path:** [@sakuramoon44](https://github.com/sakuramoon44) ([#283](https://github.com/pixel-agents-hq/pixel-agents/pull/283)), [@joemanat1997](https://github.com/joemanat1997) ([#292](https://github.com/pixel-agents-hq/pixel-agents/pull/292)), [@Ralphive](https://github.com/Ralphive) ([#295](https://github.com/pixel-agents-hq/pixel-agents/pull/295)), [@AxlLinares](https://github.com/AxlLinares) ([#306](https://github.com/pixel-agents-hq/pixel-agents/pull/306)), [@mariopablobarron](https://github.com/mariopablobarron) ([#325](https://github.com/pixel-agents-hq/pixel-agents/pull/325)), and [@NatVich](https://github.com/NatVich) ([#326](https://github.com/pixel-agents-hq/pixel-agents/pull/326)).
- **Windows message generation:** [@sakuramoon44](https://github.com/sakuramoon44) ([#280](https://github.com/pixel-agents-hq/pixel-agents/pull/280)) and [@joemanat1997](https://github.com/joemanat1997) ([#291](https://github.com/pixel-agents-hq/pixel-agents/pull/291)).
- **Standalone agent rendering:** shipped through [@bezzborodth-tech](https://github.com/bezzborodth-tech) ([#349](https://github.com/pixel-agents-hq/pixel-agents/pull/349)), with independent fixes and tests from [@miguemlima-creator](https://github.com/miguemlima-creator) ([#324](https://github.com/pixel-agents-hq/pixel-agents/pull/324)), [@Ralphive](https://github.com/Ralphive) ([#297](https://github.com/pixel-agents-hq/pixel-agents/pull/297)), [@meganechan](https://github.com/meganechan) ([#299](https://github.com/pixel-agents-hq/pixel-agents/pull/299)), [@SichAlexander](https://github.com/SichAlexander) ([#336](https://github.com/pixel-agents-hq/pixel-agents/pull/336)), and [@yshyuk](https://github.com/yshyuk) ([#338](https://github.com/pixel-agents-hq/pixel-agents/pull/338)).
- **Windows test isolation:** [@sakuramoon44](https://github.com/sakuramoon44) ([#281](https://github.com/pixel-agents-hq/pixel-agents/pull/281)), consolidated by [@elietwd](https://github.com/elietwd) ([#289](https://github.com/pixel-agents-hq/pixel-agents/pull/289)).
- **Dependency audit cleanup:** [@Suoriks](https://github.com/Suoriks) ([#345](https://github.com/pixel-agents-hq/pixel-agents/pull/345)).

Special thanks to [@sakuramoon44](https://github.com/sakuramoon44), [@Ralphive](https://github.com/Ralphive), and [@joemanat1997](https://github.com/joemanat1997) for contributing multiple fixes during this release cycle.

## v1.3.0

### Features

- **Hooks-first session management with dual-mode architecture** ([#214](https://github.com/pablodelucca/pixel-agents/pull/214)) — Splits agent detection into a preferred hooks path and a heuristic fallback. When Claude Code hooks are available, session lifecycle, tool activity, permissions, and sub-agent events are reported instantly via a local HTTP server; when unavailable, the extension transparently falls back to JSONL polling. Builds on [#187](https://github.com/pablodelucca/pixel-agents/pull/187). Closes [#188](https://github.com/pablodelucca/pixel-agents/issues/188), [#201](https://github.com/pablodelucca/pixel-agents/issues/201).
- **Claude Code hooks for instant agent status detection** ([#187](https://github.com/pablodelucca/pixel-agents/pull/187)) — Adds a standalone HTTP server and hook installer that routes 11 Claude Code hook events (SessionStart, Stop, PreToolUse, PostToolUse, SubagentStart, Notification, and others) to the webview for sub-second status updates, replacing filesystem polling when hooks are installed.
- **External session support and Agent tool recognition** ([#115](https://github.com/pablodelucca/pixel-agents/pull/115)) — Detects Claude sessions launched outside the extension (external CLIs, other editors) and recognizes the renamed `Agent` sub-agent tool so sub-agent characters spawn correctly with current Claude Code versions. Closes [#184](https://github.com/pablodelucca/pixel-agents/issues/184), [#74](https://github.com/pablodelucca/pixel-agents/issues/74), [#9](https://github.com/pablodelucca/pixel-agents/issues/9), [#8](https://github.com/pablodelucca/pixel-agents/issues/8), [#1](https://github.com/pablodelucca/pixel-agents/issues/1). Supersedes [#2](https://github.com/pablodelucca/pixel-agents/pull/2), [#77](https://github.com/pablodelucca/pixel-agents/pull/77), [#101](https://github.com/pablodelucca/pixel-agents/pull/101), [#141](https://github.com/pablodelucca/pixel-agents/pull/141).
- **Multi-root workspace agent detection** ([#102](https://github.com/pablodelucca/pixel-agents/pull/102)) — Scans all workspace folders in multi-root workspaces instead of only the first, so agents launched in any folder are discovered and adopted. Closes [#30](https://github.com/pablodelucca/pixel-agents/issues/30). Supersedes [#103](https://github.com/pablodelucca/pixel-agents/pull/103), [#157](https://github.com/pablodelucca/pixel-agents/pull/157).
- **Load custom characters from external asset directories** ([#208](https://github.com/pablodelucca/pixel-agents/pull/208)) — Users can drop custom character PNGs into an external asset directory and have them loaded alongside the built-in palettes, enabling community-contributed character skins without forking the extension.
- **Tailwind CSS v4 migration for the webview UI** ([#204](https://github.com/pablodelucca/pixel-agents/pull/204)) — Modernizes the webview styling stack to Tailwind v4, simplifying theming, reducing custom CSS, and improving build times.

### Fixes

- **Prevent duplicate restores, fix tool status reconnect, and improve agent tool detection** ([#197](https://github.com/pablodelucca/pixel-agents/pull/197)) — Stops agents being restored twice on reload, restores tool status correctly after a reconnect, and tightens the tool-name detection heuristics so active tool animations match the running tool.

### Maintenance

- **Add `shared/` to lint, format, and lint-staged** ([#212](https://github.com/pablodelucca/pixel-agents/pull/212)) — Brings the shared package under the project's lint, format, and pre-commit pipeline so cross-package code stays consistent.
- Dependabot dev-dependency group bumps ([#209](https://github.com/pablodelucca/pixel-agents/pull/209), [#210](https://github.com/pablodelucca/pixel-agents/pull/210))

### Contributors

Thank you to the contributors who made this release possible:

- [@drewf](https://github.com/drewf) — External session support and Agent tool recognition
- [@Commandershadow9](https://github.com/Commandershadow9) — Multi-root workspace agent detection
- [@mitre88](https://github.com/mitre88), [@noam971](https://github.com/noam971) — Duplicate restore, tool status reconnect, and tool detection fixes
- [@itsManeka](https://github.com/itsManeka) — Custom characters from external asset directories
- [@pablodelucca](https://github.com/pablodelucca), [@NNTin](https://github.com/NNTin) — Claude Code hooks integration, Tailwind v4 migration
- [@florintimbuc](https://github.com/florintimbuc) — Hooks-first dual-mode architecture, review coordination

## v1.2.0

### Features

- **External asset packs** ([#169](https://github.com/pablodelucca/pixel-agents/pull/169)) — Load furniture assets from user-defined directories outside the extension, enabling third-party asset packs alongside built-in furniture. Add/remove directories via Settings modal with live palette refresh.
- **Bypass permissions mode** ([#170](https://github.com/pablodelucca/pixel-agents/pull/170)) — Right-click the "+ Agent" button to launch with `--dangerously-skip-permissions`, skipping all tool-call approval prompts.
- **Improved seating, sub-agent spawning, and background agents** ([#180](https://github.com/pablodelucca/pixel-agents/pull/180)) — Agents prefer seats facing electronics (PCs, monitors). Sub-agents spawn on the closest walkable tile to their parent instead of claiming seats. Background agents stay alive until their queue-operation completes.
- **Agent connection diagnostics and JSONL parser resilience** ([#183](https://github.com/pablodelucca/pixel-agents/pull/183)) — Debug View shows agent connection state with diagnostic info. JSONL parser handles malformed/partial records gracefully. Simplified file watching to single poll for reliability.
- **Browser preview mode** ([#143](https://github.com/pablodelucca/pixel-agents/pull/143)) — Preview the Pixel Agents webview in a browser for development and review.
- **Always show overlay setting** — Option to keep agent overlay labels visible at all times, with reduced opacity for non-focused agents.

### Fixes

- **Agents not appearing on Linux Mint and macOS without a folder open** ([#70](https://github.com/pablodelucca/pixel-agents/pull/70)) — Falls back to `os.homedir()` when no workspace folder is open, matching Claude Code's own behavior.

### Testing

- **Playwright e2e tests** ([#161](https://github.com/pablodelucca/pixel-agents/pull/161)) — End-to-end test infrastructure using Playwright's Electron API with a mock Claude CLI, validating agent spawn flow in a real VS Code instance.

### Maintenance

- Add feature request template and update community docs ([#164](https://github.com/pablodelucca/pixel-agents/pull/164))
- Bump Vite 8.0, ESLint 10, and various dependency updates
- CI improvements: skip PR title check for Dependabot, restrict badge updates to main repo ([#181](https://github.com/pablodelucca/pixel-agents/pull/181))

### Contributors

Thank you to the contributors who made this release possible:

- [@marctebo](https://github.com/marctebo) — External asset packs support
- [@dankadr](https://github.com/dankadr) — Bypass permissions mode
- [@d4rkd0s](https://github.com/d4rkd0s) — Linux/macOS fix for no-folder workspaces
- [@daniel-dallimore](https://github.com/daniel-dallimore) — Always show overlay setting
- [@NNTin](https://github.com/NNTin) — Playwright e2e tests, browser preview mode
- [@florintimbuc](https://github.com/florintimbuc) — Agent diagnostics, JSONL resilience, CI improvements, code review

## v1.1.1

### Fixes

- **Fix Open VSX publishing** — Created namespace on Open VSX and added `skipDuplicate` to publish workflow for idempotent releases.

## v1.1.0

### Features

- **Migrate to open-source assets with modular manifest-based loading** ([#117](https://github.com/pablodelucca/pixel-agents/pull/117)) — Replaces bundled proprietary tileset with open-source assets loaded via a manifest system, enabling community contributions and modding.
- **Recognize 'Agent' tool name for sub-agent visualization** ([#76](https://github.com/pablodelucca/pixel-agents/pull/76)) — Claude Code renamed the sub-agent tool from 'Task' to 'Agent'; sub-agent characters now spawn correctly with current Claude Code versions.
- **Dual-publish workflow for VS Code Marketplace + Open VSX** ([#44](https://github.com/pablodelucca/pixel-agents/pull/44)) — Automates extension releases to both VS Code Marketplace and Open VSX via GitHub Actions.

### Maintenance

- **Add linting, formatting, and repo infrastructure** ([#82](https://github.com/pablodelucca/pixel-agents/pull/82)) — ESLint, Prettier, Husky pre-commit hooks, and lint-staged for consistent code quality.
- **Add CI workflow, Dependabot, and ESLint contributor rules** ([#116](https://github.com/pablodelucca/pixel-agents/pull/116)) — Continuous integration, automated dependency updates, and shared linting configuration.
- **Lower VS Code engine requirement to ^1.105.0** — Broadens compatibility with older VS Code versions and forks (Cursor, Antigravity, Windsurf, VSCodium, Kiro, TRAE, Positron, etc.).

### Contributors

Thank you to the contributors who made this release possible:

- [@drewf](https://github.com/drewf) — Agent tool recognition for sub-agent visualization
- [@Matthew-Smith](https://github.com/Matthew-Smith) — Open VSX publishing workflow
- [@florintimbuc](https://github.com/florintimbuc) — Project coordination, CI workflow, Dependabot, linting infrastructure, publish workflow hardening, code review

## v1.0.2

### Bug Fixes

- **macOS path sanitization and file watching reliability** ([#45](https://github.com/pablodelucca/pixel-agents/pull/45)) — Comprehensive path sanitization for workspace paths with underscores, Unicode/CJK chars, dots, spaces, and special characters. Added `fs.watchFile()` as reliable secondary watcher on macOS. Fixes [#32](https://github.com/pablodelucca/pixel-agents/issues/32), [#39](https://github.com/pablodelucca/pixel-agents/issues/39), [#40](https://github.com/pablodelucca/pixel-agents/issues/40).

### Features

- **Workspace folder picker for multi-root workspaces** ([#12](https://github.com/pablodelucca/pixel-agents/pull/12)) — Clicking "+ Agent" in a multi-root workspace now shows a picker to choose which folder to open Claude Code in.

### Maintenance

- **Lower VS Code engine requirement to ^1.107.0** ([#13](https://github.com/pablodelucca/pixel-agents/pull/13)) — Broadens compatibility with older VS Code versions and forks (Cursor, etc.) without code changes.

### Contributors

Thank you to the contributors who made this release possible:

- [@johnnnzhub](https://github.com/johnnnzhub) — macOS path sanitization and file watching fixes
- [@pghoya2956](https://github.com/pghoya2956) — multi-root workspace folder picker, VS Code engine compatibility

## v1.0.1

Initial public release.
