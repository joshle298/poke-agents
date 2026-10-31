# Poke Agents

Poke Agents shows your [Conductor](https://conductor.build) cloud sessions as Pokémon in a pixel-art office, live. Each session walks to a desk while it works, falls asleep when it goes idle, faints when it errors, and calls for you when it needs an answer. When one session delegates to others, the office draws the links between them and shows the messages they send. It runs in a small window next to Conductor.

Poke Agents is a fork of [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) by Pablo De Lucca, under the [MIT License](LICENSE).

## Features

- **A Pokémon per session.** Every visible cloud session is a Pokémon whose species stays with that session. It works at a desk while the session runs tools, reads on read tools, and wanders when the turn is done.
- **Levels and evolution.** `Lv` grows with session activity. A Pokémon evolves at Lv 16 and Lv 36 when its line has later stages.
- **Status conditions.** `SLP` when a session has been idle for a while, `FNT` when it errors, and `!` when it needs your answer or a permission.
- **Leads are legendaries.** A session that created other sessions is a Lead and appears as a legendary Pokémon. Its new sessions are thrown out of a Poké Ball from where it stands.
- **Links and messages.** Dashed lines connect a Lead to the sessions it created or messaged. When one session messages another, a Poké Ball flies between them with a short preview.
- **Pokédex panel.** Click a Pokémon to see its session: workspace, repository, model and harness, status, an HP bar for the context left, the task prompt, recent replies, and messages exchanged with other sessions. Actions: Open in Conductor, Send message, Revive, Stop, Deposit in PC, Hide and Pin.
- **PC Box.** Archived sessions are deposited in the PC. Withdraw one and it walks back into the office.
- **Sessions modal.** Choose which sessions are visible: your workspaces or the whole organization, an activity window, idle sessions on or off, a cap, and per-session hide and pin, with search across every session in scope.
- **Party bar.** Visible sessions as party slots with portrait, name, level, HP and status. Leads come first with their sessions under them, and a slot blinks when its session needs you.
- **Battle log.** An optional one-line ticker of events such as "Pikachu used Bash!" or "Charmander fainted!".
- **Sounds.** Each Pokémon cries when its session needs you, faints when it errors, and a Poké Ball pops when a new session arrives, with original chiptune effects for level-ups, evolutions and messages. See [Sounds](#sounds).
- **Desktop window.** `npm start` opens the office in a Chromium app window next to Conductor, and the office can be installed as a web app.

Turning the Pokémon theme off in Settings brings back the Pixel Agents look. The `--claude` flag adds upstream's Claude Code tracking (local sessions, embedded terminal and **+ Agent**).

## Requirements

- A [Conductor](https://conductor.build) Pro account with **cloud** workspaces. Conductor's public API needs Pro and only covers cloud workspaces.
- A Conductor API key in `CONDUCTOR_API_KEY`, or a Conductor CLI login (`conductor auth login`) on macOS.
- Node.js 20 or later, and git.
- macOS for the app window (Chrome, Edge, Brave, Chromium or Vivaldi). On Linux, the office works in any browser.

## Quick Start

```bash
git clone https://github.com/joshle298/poke-agents.git
cd poke-agents
npm ci       # installs dependencies and builds dist/
npm start    # opens the office in an app window
```

To update, run `git pull && npm ci && npm start`. `npm ci` rebuilds `dist/` when it was built from another commit.

Or run it straight from GitHub without cloning:

```bash
npx github:joshle298/poke-agents --open
```

npm 12 and later refuse git packages by default, so add `--allow-git=all`:

```bash
npx --allow-git=all github:joshle298/poke-agents --open
```

The first run downloads about 150 MB of build tools and builds the app, which takes 20 seconds or more. Later runs of the same commit start in about a second. Don't run `npx poke-agents`: that npm name belongs to an unrelated package.

The command prints a URL with a `?token=`. Treat it as a secret: whoever has it can use the office's session actions (send a message, stop, archive). A browser without the token can only watch.

## Using the Office

- Click a Pokémon or its party slot to open its Pokédex. Cmd-click (Ctrl-click) or double-click opens the session in Conductor.
- **Sessions** in the toolbar opens the Sessions modal. **PC** opens the PC Box.
- The × on a Pokémon or its party slot hides the session. Find it again in Sessions.
- **Settings** has the Pokémon theme, Show connections and Battle log toggles, the [Sound](#sounds) controls, and Credits for the sprites in use.

Actions that change a session are the only writes Poke Agents makes to Conductor, and each one happens only when you click it in a tokened office:

| Action        | What it does in Conductor                                                                |
| ------------- | ---------------------------------------------------------------------------------------- |
| Send message  | Sends your text to the session.                                                          |
| Revive        | Sends "continue" to a fainted (errored) session.                                         |
| Stop          | Cancels the session's turn. Asks first, because Conductor drops messages still queued.   |
| Deposit in PC | Archives the session. Asks first. The session leaves the office and is listed in the PC. |
| Withdraw      | Unarchives a session from the PC Box. It walks back into the office.                     |

### How Visibility Works

Poke Agents polls Conductor for sessions in scope and shows up to a cap of them. Change all of this in the Sessions modal; the choices are saved.

- **Scope:** your workspaces (default) or the whole organization.
- **Activity window:** workspaces and sessions active in the last 6 hours by default.
- **Show idle:** on by default. Off keeps only working, waiting and errored sessions.
- **Cap:** 24 sessions by default. When more are in scope, they are ranked in this order: pinned, waiting for you, working, errored, Leads with visible active sessions, then most recent activity. A shown session stays until it falls 4 places past the cap, so the office doesn't flicker. At most 12 sessions per Lead are shown; the rest are listed in the Sessions modal.
- **Hide** removes a session from the office until you show it again. **Pin** always shows it.

Sessions that never started (no name, no model and no messages) are ignored.

### Leads and Links

A session becomes a Lead when it creates another session with a first message, for example with `conductor workspace create --message` or `conductor session create`. Leads appear as legendary Pokémon and don't evolve. Lines between sessions show how they are connected:

- solid dashes: the Lead created that session
- dots: one session messaged the other
- faint: one session read the other's messages

## Sounds

Each Pokémon makes sounds when something happens to its session. Sound is on by default and starts after your first click or key press in the office: browsers keep audio locked until then, and nothing that happened before is played late.

| When                                                          | You hear                                              |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| A session needs your answer or a permission                   | An alert, then its Pokémon's cry                      |
| A session errors (faints)                                     | Its cry, pitched down, and a falling tone             |
| A fainted session works again                                 | A rising heal arpeggio                                |
| A Pokémon levels up                                           | A short level-up arpeggio                             |
| A Pokémon evolves                                             | A rising shimmer, then the new species' cry           |
| A Lead creates a session                                      | A Poké Ball throw, the pop, and the new Pokémon's cry |
| Any other session appears                                     | The pop and its cry                                   |
| One session messages another                                  | A whoosh                                              |
| A session leaves the office (hidden, deposited, out of scope) | A recall zap                                          |
| The selected or a pinned session finishes its turn            | A soft two-note tone                                  |
| You open a Pokédex                                            | That Pokémon's cry                                    |

A busy office stays bearable: at most four sounds a second, one cry at a time, a cooldown per session, nothing for five seconds after the office connects, and no level-up sound while a session's real level is being filled in. With the Pokémon theme off, only the alert, faint and done tones play. Claude Code agents (`--claude`) keep the upstream chime.

**Settings → Sound** has the on/off switch (**Sounds**), a volume slider, toggles for **Cries**, **Alerts** (needs you, faint, done) and **Effects** (everything else), and a button to test each sound. The volume and the toggles are saved per device.

**Cries** are the official cries from the [PokéAPI cries](https://github.com/PokeAPI/cries) project, which collects them from Pokémon Showdown, Veekun and The Sounds Resource. Poke Agents downloads a species' cry from `raw.githubusercontent.com` the first time it's needed and keeps it in `~/.pixel-agents/cache/cries/`. Cries are © Nintendo, Creatures Inc. and GAME FREAK inc. They are fetched on your computer and are not included in or redistributed by this repository. The other effects are original chiptune sounds synthesized in the app; none reuses music from the games.

**Sound pack.** To use your own sounds, put files in `~/.pixel-agents/sounds/` named after the effect they replace, with the extension `.ogg`, `.mp3` or `.wav`, for example `~/.pixel-agents/sounds/levelUp.ogg`:

`alert`, `done`, `faint`, `heal`, `levelUp`, `evolution`, `ballThrow`, `ballPop`, `recall`, `message`, `blip`

Use the names exactly as written. Each file must be an audio file of at most 2 MB, not a link. Its volume is matched to the built-in sounds. Settings → Sound lists the files in use; reopen Settings after adding one. Use only sounds you have the right to use. Cries can't be replaced.

**To mute**, turn off **Sounds** in Settings, or one of the three categories. `--no-sounds` (or `POKE_AGENTS_SOUNDS=off`) stops cry downloads and the sound pack; the synthesized effects follow the Settings switch.

## Configuration

| Flag                     | Default      | Effect                                                                                                                                                                         |
| ------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--open`, `--app`        | off          | Open the office in a Chromium app window. macOS tries Chrome, Edge, Brave, Chromium, Vivaldi and Chrome Canary in that order, then the default browser. Linux uses `xdg-open`. |
| `--browser <id>`         | first found  | Use this browser for `--open`. `poke-agents --help` lists the ids.                                                                                                             |
| `--port`, `-p <number>`  | `41510`      | Port to listen on. When 41510 is busy and no `--port` was given, a free port is used instead.                                                                                  |
| `--host <address>`       | `127.0.0.1`  | Address to bind to. `0.0.0.0` exposes the office to your network.                                                                                                              |
| `--no-conductor`         | Conductor on | Don't connect to Conductor.                                                                                                                                                    |
| `--claude`               | off          | Also track local Claude Code sessions, as upstream Pixel Agents does: hooks (after you consent in the app), the embedded terminal and **+ Agent**.                             |
| `--conductor-budget <n>` | `120`        | Most Conductor API requests per minute.                                                                                                                                        |
| `--no-sprites`           | sprites on   | Never download sprites. The office shows the upstream characters.                                                                                                              |
| `--no-sounds`            | sounds on    | Never download cries or serve the sound pack. Synthesized effects still follow Settings → Sound.                                                                               |

Upstream's `--no-terminal`, `--allowed-host` and `--rotate-token` work as described under [Upstream Pixel Agents](#upstream-pixel-agents). The embedded terminal only exists with `--claude`.

| Environment variable           | Effect                                                                    |
| ------------------------------ | ------------------------------------------------------------------------- |
| `CONDUCTOR_API_KEY`            | Conductor API key. Checked first.                                         |
| `CONDUCTOR_API_TOKEN`          | Used when `CONDUCTOR_API_KEY` is not set.                                 |
| `CONDUCTOR_API_URL`            | Conductor API base URL. Default `https://api.conductor.build`.            |
| `POKE_AGENTS_SPRITES`          | `off` disables sprite downloads, like `--no-sprites`.                     |
| `POKE_AGENTS_SOUNDS`           | `off` disables cry downloads and the sound pack, like `--no-sounds`.      |
| `POKE_AGENTS_CONDUCTOR_BUDGET` | Conductor API requests per minute when `--conductor-budget` is not given. |
| `POKE_AGENTS_SKIP_BUILD`       | `1` skips building `dist/` during `npm install` or `npm ci`.              |

Without either variable, Poke Agents on macOS reads the token that `conductor auth login` saved in the Keychain (service `com.conductor.cli`). With no token at all, the office asks you to sign in with `conductor auth login` or set `CONDUCTOR_API_KEY`, then restart.

Poke Agents keeps its data in `~/.pixel-agents/`, shared with upstream Pixel Agents: `conductor-state.json` holds the scope, hidden and pinned sessions and each session's Pokémon (never the token), `cache/pmd/` holds downloaded sprites, `cache/cries/` downloaded cries, and `sounds/` your [sound pack](#sounds).

## Privacy

- Poke Agents makes outbound requests only to the Conductor API (`api.conductor.build`, or `CONDUCTOR_API_URL`), for sprites to `raw.githubusercontent.com` with `cdn.jsdelivr.net` as a fallback, and for cries to `raw.githubusercontent.com`. With the Pokémon theme off or `--no-sprites`, it fetches no sprites and no cries; with `--no-sounds`, no cries.
- Your Conductor token is never written to disk, logged, or passed on a command line. Poke Agents reads it from the environment or the Keychain each time it starts.
- Reads use GET requests. Writes to Conductor happen only for the actions above, when you click them.
- There is no telemetry or analytics.

## Troubleshooting

- **My local (Mac) Conductor workspaces don't appear.** Conductor's public API only covers cloud workspaces, and local workspaces have no API. Only cloud sessions can appear.
- **"Sign in with `conductor auth login`".** No token was found. Run `conductor auth login` on macOS or set `CONDUCTOR_API_KEY` (a Pro account is needed for API keys), then restart Poke Agents.
- **Sessions update slowly, or the status line reports rate limiting.** Conductor limits API requests, and the limit may be shared with your sessions' own `conductor` CLI calls. Poke Agents halves its request rate after a rate-limit reply and recovers slowly. Lower the rate with `--conductor-budget`, or narrow the scope and cap in Sessions.
- **macOS asks to allow access to a Keychain item.** That is the token `conductor auth login` saved. Choose Allow, or set `CONDUCTOR_API_KEY` to skip the Keychain.
- **The office opens in a normal browser tab.** No supported Chromium browser was found. Install Chrome, or pick one with `--browser`.
- **An installed web app can't connect after a restart.** Port 41510 was busy, so the office started on another port. Stop whatever holds 41510, or always pass the same `--port`.
- **No sound.** Click or press a key in the office once: browsers keep audio locked until then. Check that **Sounds** is on in Settings and the volume is up.
- **No cries, but the other sounds play.** Cries download in the background from `raw.githubusercontent.com` and are mostly Ogg files: Chrome, Edge, Firefox and the Mac app play them; some Safari versions can't. They also need the Pokémon theme and sprites on.
- **Pokémon show as office workers.** Sprites download in the background, and the upstream character shows until a sprite is ready. If it never changes, check that `raw.githubusercontent.com` or `cdn.jsdelivr.net` is reachable.

## Mac Verification Checklist

These need a Mac and can't be checked in CI:

1. `npm start` opens a Chrome app window. Without Chrome, the default browser opens.
2. With `conductor auth login` done and no `CONDUCTOR_API_KEY`, the office connects. Note whether macOS shows a Keychain prompt.
3. **Open in Conductor** in the Pokédex (or Cmd-click on a Pokémon) opens the right session in the Conductor app.
4. Cloud sessions appear within about 10 seconds. A session spawned by a Lead appears thrown out of the Lead, with a link.
5. Install the office as an app from Chrome. After stopping and restarting `npm start`, the installed app still connects (fixed port 41510).
6. Optional: with `--claude`, check whether local Conductor workspaces appear through their Claude Code transcripts.

## Development

```bash
npm ci
npm run build                      # protocol generation, type check, lint, esbuild and Vite
node dist/cli.js --no-conductor    # run the office without Conductor
```

Checks:

```bash
npm run check-types
npm run lint
npm test
POKE_AGENTS_SPRITES=off npm run e2e -- e2e/tests/standalone --workers=1
```

Standalone end-to-end tests run without Conductor and without sprites. The VS Code tests in `e2e/tests/claude` open VS Code windows on your screen. Commits run [gitleaks](https://github.com/gitleaks/gitleaks) through a husky hook, so install it first (`brew install gitleaks`). See [CONTRIBUTING.md](CONTRIBUTING.md), and use [Issues](https://github.com/joshle298/poke-agents/issues) for bugs and ideas.

## Credits and Disclaimer

Poke Agents is a fan project and is not affiliated with, endorsed, sponsored or approved by Nintendo, The Pokémon Company, Creatures Inc., GAME FREAK inc. or Spike Chunsoft. Pokémon and Pokémon character names are trademarks of Nintendo, Creatures Inc. and GAME FREAK inc.

This repository contains no Pokémon artwork. When the Pokémon theme is on, the app downloads sprites and portraits from the PMD Sprite Repository ([sprites.pmdcollab.org](https://sprites.pmdcollab.org), [PMDCollab/SpriteCollab](https://github.com/PMDCollab/SpriteCollab)) to a cache on your computer. Sprites credited to CHUNSOFT come from the Pokémon Mystery Dungeon games, © Nintendo, Creatures Inc., GAME FREAK inc. and Spike Chunsoft. Community sprites and portraits are © their credited artists and licensed under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). Use them only for non-commercial purposes: don't sell, advertise in or host a public demo of a build that shows them. **Settings → Credits** lists the artists for each species in use.

When sounds are on, the app also downloads Pokémon cries from the [PokéAPI cries](https://github.com/PokeAPI/cries) project (collected from Pokémon Showdown, Veekun and The Sounds Resource) to the same cache. Cries are © Nintendo, Creatures Inc. and GAME FREAK inc., fetched at runtime and not redistributed. The other sound effects are original compositions synthesized in the app.

The Poke Agents source code is MIT-licensed. The MIT license does not cover the downloaded artwork or cries.

The office, its characters and furniture come from Pixel Agents. Its characters are based on [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack). Support upstream Pixel Agents:

<a href="https://github.com/sponsors/pablodelucca">
  <img src="https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=github" alt="GitHub Sponsors">
</a>
<a href="https://ko-fi.com/pablodelucca">
  <img src="https://img.shields.io/badge/Support-Ko--fi-ff5e5b?logo=ko-fi" alt="Ko-fi">
</a>

## License

Poke Agents is a fork of [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) by Pablo De Lucca. Both are available under the [MIT License](LICENSE), which keeps the upstream copyright notice.

## Upstream Pixel Agents

The rest of this README is upstream Pixel Agents' documentation, kept for the features Poke Agents inherits: the layout editor, Claude Code tracking with `--claude`, and the standalone server options. Where it says `npx pixel-agents` or `pixel-agents`, run `poke-agents --claude` (or `node dist/cli.js --claude` in a clone). Poke Agents listens on port 41510 by default instead of a fresh port each start. The VS Code extension, Marketplace listing and `pixel-agents` npm package it mentions are upstream's.

Pixel Agents turns the AI coding agents running in your terminals into animated pixel-art characters working in a tiny office. They walk to their desks, sit down, type when they're editing files, read when they're searching, and flag you visually when they're stuck waiting for input.

It ships in two forms from the same codebase:

- **VS Code extension** — [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents) and [Open VSX](https://open-vsx.org/extension/pablodelucca/pixel-agents). Agents launch into VS Code terminals; characters render in the panel area.
- **Standalone CLI** — `npx pixel-agents` starts a local server and serves the same office as a browser app, useful for tmux, remote, and non-VS Code workflows.

The architecture is fully agent-agnostic and editor-agnostic: a typed `HookProvider` interface defines the integration boundary so adding a new AI tool is a single subdirectory of code. Claude Code is the reference implementation today; Codex, Gemini, Cursor, and others are on the roadmap.

![Pixel Agents screenshot](webview-ui/public/office.png)

### Features

- **One agent, one character** — every Claude Code terminal gets its own animated character
- **Live activity tracking** — characters animate based on what the agent is actually doing (writing, reading, running commands)
- **Office layout editor** — design your office with floors, walls, and furniture using a built-in editor
- **Speech bubbles** — visual indicators when an agent is waiting for input or awaiting permission
- **Sound notifications** — optional chimes when an agent finishes its turn or requests permission
- **Sub-agents and Agent Teams** — see ephemeral sub-agents and persistent Claude teammates as separate characters, including team roles and lifecycle changes
- **Persistent layouts** — your office design is saved and shared across VS Code windows
- **Shared layout and assets** — import/export layouts and load external character, pet, and furniture packs
- **Areas** — paint named areas onto the office, map workspace folders to them, and new agents sit inside the areas mapped to their folder
- **Diverse characters** — 6 diverse characters. These are based on the amazing work of [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack).

<p align="center">
  <img src="webview-ui/public/characters.png" alt="Pixel Agents characters" width="320" height="72" style="image-rendering: pixelated;">
</p>

### Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and configured
- **VS Code extension:** VS Code 1.105.0 or later
- **Standalone CLI:** Node.js 20 or later
- Windows, Linux, or macOS

### Getting Started

#### VS Code extension

1. Install Pixel Agents from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents) or [Open VSX](https://open-vsx.org/extension/pablodelucca/pixel-agents).
2. Open the **Pixel Agents** panel beside the terminal.
3. Click **+ Agent** to open its drawer of **Directories**, then click one to launch Claude Code in it. Your workspace folders are listed there once you turn on **Settings → Show Workspace Folders**; **+ Directory** adds your own (a name, a path, and optionally the Areas its agents should sit in), and the pencil on a row you added edits or deletes it.

To use Claude with `--dangerously-skip-permissions`, turn on **Settings → Skip Permissions**. It stays on for every agent launched from that host until you turn it off. Only use this when you accept the security implications.

Pixel Agents also detects Claude sessions started outside the extension. Turn on **Settings → Watch All Sessions** to include sessions from other workspaces.

#### Standalone CLI

Run Pixel Agents from the workspace whose Claude sessions you want to see:

```bash
cd /path/to/your/project
npx pixel-agents
```

The CLI chooses a free local port and prints the URL. Click **+ Agent** to open the Directory drawer and click a Directory to launch Claude Code in it; the agent's terminal opens in the browser. **+ Directory** adds your own, and **Settings → Show Start Directory** lists the directory the CLI was started from. On a phone, tap the **+** card to open the same drawer and tap a Directory to launch (long-press a Directory you added to edit it). Claude Code started in your own terminal is picked up too. To install the command globally instead:

```bash
npm install --global pixel-agents
pixel-agents
```

Use a fixed address or port when needed:

```bash
pixel-agents --port 3100
pixel-agents --host 127.0.0.1 --port 3100
pixel-agents --no-terminal
pixel-agents --help
```

The default bind address is `127.0.0.1`. Binding to `0.0.0.0` exposes the UI and WebSocket to the local network; do this only on a trusted network.

Open the URL the CLI prints - it carries a `?token=` for this server. Any browser can watch the office without it, but installing or removing hooks (which edits your agent tool's own settings file, like the `~/.claude/settings.json`), launching agents from the browser and attaching to their terminals are only offered to a session that has the token, so an untokened client on the network cannot approve or do any of it. Open the bare address instead and the hooks toggle in Settings is refused (reporting the actual install state rather than appearing to work) and the **+ Agent** button explains what it needs. Standalone keeps the same token across restarts (in `~/.pixel-agents/standalone-token`, readable only by you), so a bookmarked or home-screen URL keeps working — as long as the port stays the same too, which takes `--port` (the default port is picked fresh on every start).

Treat that URL as a secret: the token is a bearer capability, not proof of being local. Whoever holds it can approve the hook install from anywhere the server is reachable — so don't paste the URL into a shared channel, and note that it also lands in your browser history (the server's own request log redacts it).

Pass `--no-terminal` to disable the embedded terminal — watch agents without launching or attaching to them from the browser.

Copying from the embedded terminal is verbatim: Cmd+C (Mac), Ctrl+C or Ctrl+Shift+C with a selection (Windows, Linux), the browser's Copy, and the **Copy** button on a phone copy exactly what is on screen. Claude Code wraps long prose into lines indented two spaces; to copy such a passage as flowing text instead, select it and press **Alt+C** (**Option+C** on a Mac), or tap **Copy as text** on a phone. On a phone opened over plain `http://` (a LAN address), the paste key asks for the text in a prompt, since the page cannot read the clipboard there.

#### Running the extension and standalone together

The extension and standalone CLI can run at the same time. Each server registers under `~/.pixel-agents/servers/`; the hook script sends events to all active registrations. VS Code and standalone keep separate agents, seats, and settings while using the shared office layout.

Stop a standalone server with **Ctrl+C**. It removes only its own registration.

### Customizing the Office

Click **Layout** to edit the office:

- Paint floor patterns and walls, with color and contrast controls.
- Place, rotate, recolor, select, and remove furniture.
- Paint auto-tiling carpets and customize their main and accent colors.
- Add animated pets; click a pet in the office to interact with it.
- Create named **Areas**, paint their tiles, and assign Directories to them (agents launched in a Directory prefer seats in its Areas).
- Undo/redo changes, then import or export the complete layout as JSON.

Layouts can grow to 64×64 tiles by clicking the ghost border outside the current grid.

#### Office assets

Bundled furniture, floors, walls, carpets, characters, and pets live under `webview-ui/public/assets/`. Furniture manifests describe sprites, rotation groups, state groups, and animation frames.

Use **Settings → Add Asset Directory** to load external characters, pets, and furniture. See [docs/external-assets.md](docs/external-assets.md) for furniture directory structure and manifest details. The visual asset manager at `scripts/asset-manager.html` helps create furniture manifests.

### How It Works

Pixel Agents uses two Claude Code detection paths:

- **Hooks mode** (default) — a hook script receives Claude events such as `SessionStart`, `PreToolUse`, `PermissionRequest`, and `Stop`. It discovers active Pixel Agents servers and sends authenticated events to each one.
- **Heuristic mode** (fallback) — when hooks are unavailable, the runtime infers agent status by scanning Claude's JSONL session transcripts under `~/.claude/projects/`. Transcripts are also read in hooks mode for details not present in an event.

The Claude provider normalizes both sources into a shared `AgentEvent` model. `AgentRuntime` updates the central state store, and the active transport sends typed messages to the React webview. The office renders through Canvas 2D with pathfinding and character state machines.

Pixel Agents does not modify Claude Code. Its hook configuration and persistent data live under `~/.claude/` and `~/.pixel-agents/` respectively.

#### Architecture

- **`core/`** — provider, adapter, transport, schema, and AsyncAPI message contracts with no runtime side effects.
- **`server/`** — shared Fastify server, agent runtime, persistence, Claude provider, transcript scanning, and standalone CLI.
- **`adapters/vscode/`** — the VS Code adapter: terminal, persistence, and webview bridge.
- **`webview-ui/`** — React 19, Vite, Canvas 2D, and adapter-specific transports for VS Code and browser WebSocket clients.

The extension and CLI are bundled with esbuild; the webview is built with Vite. Unit tests use Vitest and Node's test runner, and end-to-end coverage uses Playwright against VS Code and standalone.

### Troubleshooting

- **Standalone will not start:** verify Node.js 20+, omit `--port` to choose a free port, or select another fixed port.
- **An agent is missing:** confirm **Settings → Instant Detection (Hooks)** is on and that the session belongs to the current workspace. Enable **Watch All Sessions** if needed.
- **The UI looks disconnected:** open **Settings → Debug View** to inspect the server connection, transcript path, and latest agent data.
- **Extension and standalone are both running:** this is supported. Current versions create separate files under `~/.pixel-agents/servers/`; stopping one does not remove the other.
