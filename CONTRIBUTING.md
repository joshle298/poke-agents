# Contributing to Poke Agents

Thanks for your interest in contributing to Poke Agents! All contributions are welcome — features, bug fixes, documentation improvements, refactors, and more. Poke Agents is inspired by and based on [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) by Pablo De Lucca; fixes to code the two share may belong upstream too.

Poke Agents is a visualizer for Conductor. A change must not make it run agents, start sessions, edit repositories, or store or change Conductor settings; actions only ask Conductor's API to act, on the user's click. The README's "What It Is" section is the contract. Upstream's `--claude` mode is the opt-in exception.

This project is licensed under the [MIT License](LICENSE), so your contributions will be too. No CLA or DCO is required.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (use the version in [`.nvmrc`](.nvmrc), currently v22)
- [gitleaks](https://github.com/gitleaks/gitleaks) (`brew install gitleaks`): the husky pre-commit hook refuses commits without it
- [VS Code](https://code.visualstudio.com/) (v1.105.0 or later), only for the VS Code extension

### Setup

```bash
git clone https://github.com/joshle298/poke-agents.git
cd poke-agents
npm ci          # also builds dist/ (scripts/prepare.mjs)
npm run build   # full compile: protocol generation, type check, lint, esbuild, Vite
node dist/cli.js --no-conductor
```

`npm ci` and `npm install` run `scripts/prepare.mjs`, which installs the git hooks and builds `dist/` when it is missing or was built from another commit. Set `POKE_AGENTS_SKIP_BUILD=1` to skip that build. Run without `--no-conductor` to poll your Conductor account (see the README for sign-in), and add `--claude` to work on the Claude Code provider.

For the VS Code extension, press **F5** in VS Code to launch the Extension Development Host.

### Build and install the packaged extension locally

If you want to test the extension the same way end users install it, build a `.vsix` package and install it through the VS Code CLI:

```bash
npx @vscode/vsce package --allow-star-activation --out pixel-agents-local.vsix
code --install-extension ./pixel-agents-local.vsix --force
```

`--force` updates the existing local install with your freshly built package.

If you are using Remote SSH, WSL, or a dev container, `code --install-extension` installs the extension into that current VS Code target.

After installing the `.vsix`, run **Developer: Reload Window** in VS Code to load the updated extension.

### Verify the npm package locally

The npm artifact has its own gate because source-level tests cannot detect a missing tarball file or a package-relative path bug:

```bash
npm run test:package-contract
npm run verify:npm-package
```

The verifier runs the production `prepack` build, creates a tarball outside the repository, installs that exact tarball into a temporary project, and checks the package identity (`@joshle298/poke-agents`, one `poke-agents` bin), CLI help, the `Poke Agents running at` URL line, the health endpoint, the standalone SPA, bundled assets, and Claude hook setup. It starts the CLI with `--no-conductor --claude`, sprites off and Conductor credentials removed from its environment. Temporary files and the child server are removed automatically; it never publishes to npm.

`npm pack --dry-run` lists what would ship. `npx github:joshle298/poke-agents` installs from git, which runs `prepare` to build `dist/` first. `npm run test:package-contract` also runs `scripts/docs-contract.test.mjs`, which fails when the README's flag and environment tables, defaults or data files drift from the code, or when CLAUDE.md's protocol message counts drift from `core/asyncapi.yaml`.

### Releases

Poke Agents has no release workflow and is not published to npm. Users install it from GitHub: a clone with `npm ci && npm start`, or `npx github:joshle298/poke-agents --open`. To ship a change, update `CHANGELOG.md` and push to `main`. For a new version, also set the `version` in `package.json`, both root-version fields in `package-lock.json`, `desktop/package.json` and both root-version fields in `desktop/package-lock.json` (the Mac app's build and tests check that it matches), and add the version's entry at the top of `webview-ui/src/changelogData.ts` (the in-app notes; a test checks it matches).

`scripts/publish-npm-package.mjs` and the release identity in `scripts/npm-package-contract.mjs` remain for a deliberate npm release job later. That job would need npm trusted publishing configured for `@joshle298/poke-agents`. Never publish or document the unscoped `poke-agents` name, which belongs to an unrelated package.

### Mac app checklist

Before calling a version done, run these on a Mac; CI can't check them:

1. `npm start` opens a Chrome app window. Without Chrome, the default browser opens.
2. With `conductor auth login` done and no `CONDUCTOR_API_KEY`, the office connects. Note whether macOS shows a Keychain prompt.
3. **Open in Conductor** in the Pokédex (or Cmd-click on a Pokémon) opens the right session in the Conductor app.
4. Cloud sessions appear within about 10 seconds. A session spawned by a Lead appears thrown out of the Lead, with a link.
5. Install the office as an app from Chrome. After stopping and restarting `npm start`, the installed app still connects (fixed port 41510).
6. Optional: with `--claude`, check whether local Conductor workspaces appear through their Claude Code transcripts.
7. `npm run app:mac` builds the app for your Mac, and it opens from Finder with no Gatekeeper warning.
8. The icon: in the Dock, Finder (icon and list view), Cmd-Tab and Spotlight it shows the capsule (a teal cap and a cream body with a gold C) on its dark tile, not a grey square around it (on macOS 26 and later, check that it isn't shown inside a grey rounded square; if it is, the tile needs Apple's exact shape or an Icon Composer file). Compare the 16 and 32 px sizes in Finder's list view with `iconutil -c iconset desktop/resources/icon.icns` output.
9. Opened from Finder with only `conductor auth login` done, the app connects after you allow the Keychain prompt. Without a sign-in it shows the app's steps; **Reconnect** connects after `conductor auth login`, and says so when it still can't. Choosing Deny, then Reconnect and Allow, also connects.
10. Soon after the first connection, a "Watching your Conductor sessions" notification appears and macOS asks to allow notifications.
11. A session that starts waiting for an answer posts a notification while another app is in front; clicking it opens that session's Pokédex. The notification leaves Notification Center when the session continues. The Dock badge counts waiting sessions and clears when they continue.
12. **File → Close Window** (Cmd-W) keeps the app in the Dock, clicking the Dock icon reopens it, and Cmd-Q quits. Reopened, the window keeps its size and position. **Settings…** (Cmd-,) opens Settings, and the title bar stays dark in Light Mode.
13. With `npm start` running, the app opens the same office; after stopping `npm start`, the app keeps working on its own server.
14. With the app quit, `open -a "Poke Agents" --args --demo` opens the demo office: the scripted sessions appear without a Conductor sign-in, and a session that faints or asks a question posts a notification.

## Development Workflow

For development with live rebuilds, run:

```bash
npm run watch
```

This starts parallel watchers for both the extension backend (esbuild) and TypeScript type-checking.

> **Note:** The webview (Vite) is not included in `watch` — after changing webview code, run `npm run build:webview` or the full `npm run build`.

## Running the Mocked Pixel Agent

You can run the mocked Pixel Agent web app either from the CLI or from VS Code tasks.

### Option 1: CLI

From the repository root:

```bash
npm run dev -w webview-ui
```

Vite will print a local URL (typically `http://localhost:5173`) where the mocked app is available.

### Option 2: VS Code Run Task

1. Open the command palette and run **Tasks: Run Task**.
2. Select **Mocked Pixel Agent Dev Server**.
3. Open the local URL shown in the task terminal output (typically `http://localhost:5173`).

### Project Structure

Pixel Agents uses a layered codebase. `core/` depends on nothing; `server/` and `webview-ui/` depend only on `core/`; `adapters/vscode/` depends on `core/` and `server/`.

| Directory                   | Description                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core/`                     | Protocol + interface definitions (AsyncAPI 3.0 contract, HookProvider, MessageTransport, StateAdapter). Zero runtime side effects.                                                                                                               |
| `server/`                   | Lifecycle runtime: `AgentRuntime`, `AgentStateStore`, `SessionRouter`, `DismissalTracker`, Fastify HTTP/WS server, file watching, transcript parsing, hook installer, providers, Vitest test suite. Also ships the `poke-agents` standalone CLI. |
| `adapters/vscode/`          | VS Code surface — `extension.ts`, `WebviewViewProvider`, terminal lifecycle, one-time state migration. Composes `core/` and `server/`.                                                                                                           |
| `webview-ui/`               | React 19 + Canvas UI. Transport abstraction (`PostMessageTransport` + `WebSocketTransport`). Depends only on `core/`.                                                                                                                            |
| `webview-ui/public/assets/` | Bundled sprites, furniture catalog, default layout, fonts.                                                                                                                                                                                       |
| `scripts/`                  | Build/CI tooling: `generate-messages.ts` (AsyncAPI → TS), `run-e2e.mjs`, `build-allure-report.mjs`, `assemble-vercel-output.mjs`, and the asset extraction pipeline.                                                                             |
| `e2e/`                      | Playwright suite — fixtures, helpers, specs for `claude/hooks-on/`, `claude/hooks-off/`, and `standalone/`.                                                                                                                                      |
| `eslint-rules/`             | Custom rules (`no-inline-colors`, `pixel-shadow`, `pixel-font`) enforced project-wide.                                                                                                                                                           |

The repo uses **npm workspaces** (`server`, `webview-ui` declared in the root `package.json`). A single `npm install` at the root installs dependencies for all workspaces; no nested `cd ... && npm install` is needed.

## Manual Hook Testing

The repo includes [server/manual-hook-events.http](server/manual-hook-events.http) for manually driving the local hook server while the extension is running.

It covers the basic external-session lifecycle:

- `SessionStart` to stage a pending external session
- `PreToolUse` to confirm it and mark the agent active
- `PermissionRequest`, `Notification`, and `Stop` to drive permission/waiting states
- `SessionEnd` to despawn the agent

Before using it, copy `port` and `token` from `~/.pixel-agents/server.json` into the file variables and set `cwd` to a workspace folder opened in the Extension Development Host. If `cwd` is outside the current workspace, enable **Watch All Sessions** in Pixel Agents first.

## Code Guidelines

### Constants

**No unused locals or parameters** (`noUnusedLocals` and `noUnusedParameters` are enabled). All magic numbers and strings are centralized — don't add inline constants to source files:

- **Shared backend timing/scanning constants:** `server/src/constants.ts` (imported by `adapters/vscode/` too)
- **VS Code-only IDs / command names:** `adapters/vscode/constants.ts`
- **Protocol-level constants:** `core/src/constants.ts`
- **Webview:** `webview-ui/src/constants.ts` (grid, animation, rendering, camera, zoom, editor, canvas overlay rgba strings)
- **CSS variables:** `webview-ui/src/index.css` `:root` block (`--pixel-*` properties for React inline styles and CSS)

### UI Styling

The project uses a pixel art aesthetic. All overlays should use:

- Sharp corners (`border-radius: 0`)
- Solid backgrounds and `2px solid` borders
- Hard offset shadows (`2px 2px 0px`, no blur) — use `var(--pixel-shadow)`
- The FS Pixel Sans font (loaded in `index.css`)

These conventions are enforced by custom ESLint rules (`eslint-rules/pixel-agents-rules.mjs`):

| Rule               | Scope               | What it checks                                              |
| ------------------ | ------------------- | ----------------------------------------------------------- |
| `no-inline-colors` | Extension + Webview | No hex/rgb/rgba/hsl/hsla literals outside `constants.ts`    |
| `pixel-shadow`     | Webview only        | Box shadows must use `var(--pixel-shadow)` or `2px 2px 0px` |
| `pixel-font`       | Webview only        | Font family must reference FS Pixel Sans                    |

These rules are set to `error` and will block your PR if violated.

## Unit & Integration Tests

```bash
# Run all tests (webview + server)
npm test

# Run only server tests (Vitest)
npm run test:server

# Run only webview tests
npm run test:webview
```

Server tests cover `AgentStateStore` (typed mutations + events), `HookEventHandler` (routing, buffering, team gating), `SessionRouter` and `DismissalTracker`, `FileStateAdapter` (namespaced persistence), `migrateVsCodeState` (verify-before-clear), `teamUtils`, the Claude provider and its team extension, the hook installer, the HTTP server (lifecycle, auth, `/ws`, broadcast), and the hook script via a spawned-process integration test.

`claude-hook.test.ts` requires the bundled hook at `dist/hooks/claude-hook.js`, so build before running it (or use `npm test` which builds first).

## End-to-End Tests

The `e2e/` directory contains Playwright tests that launch a real VS Code instance with the extension loaded in development mode.

### Running e2e tests locally

```bash
# Build the extension first (tests load the compiled output)
npm run build

# Runs the e2e tests
npm run e2e

# Step-by-step debug mode
npm run e2e:debug

# Keep and attach videos even for successful tests
npm run e2e -- --attach-videos-on-success

# Combine debugger + success-case videos
npm run e2e:debug -- --attach-videos-on-success
```

On the first run, `@vscode/test-electron` will download a stable VS Code release into `.vscode-test/` (≈200 MB). Subsequent runs reuse the cache.

### Artifacts

All test artifacts are written to `test-results/e2e/`:

| Path                                   | Contents                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `test-results/e2e/videos/<test-name>/` | `.webm` screen recording for failed tests, or all tests with the debug flag |
| `playwright-report/e2e/`               | Playwright HTML report (`npx playwright show-report playwright-report/e2e`) |
| `test-results/e2e/*.png`               | Final screenshots saved on failure                                          |

By default, successful tests discard their videos after teardown. Pass `--attach-videos-on-success` when you need success-case recordings attached to the report for debugging.

### Mock claude

Tests never invoke the real `claude` CLI. A wrapper script (`e2e/fixtures/mock-claude` on POSIX, `mock-claude.cmd` on Windows) is copied into an isolated `bin/` directory and prepended to `PATH` before VS Code starts. The wrapper delegates to `e2e/fixtures/mock-claude-runner.cjs`, which honors a scenario blob set by the test via the `MOCK_CLAUDE_SCENARIO` env var.

Tests build scenarios with the fluent `claudeScenario(...)` helper in `e2e/helpers/mock-claude.ts`:

```typescript
claudeScenario('my-scenario')
  .at(2_000)
  .appendJsonl(buildAssistantToolUseRecord('toolu-1', 'Read', { file_path: '/x' }))
  .at(3_000)
  .emitHook(preToolUseRead('sessionId', '/x'))
  .holdOpenFor(10_000)
  .build();
```

`appendJsonl` writes a record to `$HOME/.claude/projects/<project-hash>/<session-id>.jsonl` at the given offset. `emitHook` POSTs a hook event to the running server's `/api/hooks/:providerId`. `holdOpenFor` keeps the wrapper process alive (and the terminal "busy") for that many ms after the last action, then exits.

Each test runs with an isolated `HOME`, workspace directory, VS Code `--user-data-dir`, and mock log file — no state leaks between runs or into your real VS Code profile.

For the normative model behind this (the process-boundary principle, append-only transcript rule, assertion philosophy, and the one standalone-server exception), see [`e2e/README.md` → "Mocking model & rules"](e2e/README.md#mocking-model--rules).

### E2E test naming

Tests use behavioral sentences with `@area:<tag>` suffixes for grouping. Areas: `spawn`, `lifecycle`, `cross-cutting`, `teams`, `matrix`, `standalone`. Example:

```typescript
test('rapid /clear then new tool within 500ms lands on the reassigned agent @area:lifecycle', ...);
```

The auto-generated test inventory in `e2e/README.md` groups tests by `@area:` tag. After adding or removing tests, run `npm run e2e:inventory` to regenerate — CI fails if it drifts.

## Submitting a Pull Request

1. Fork the repo and create a feature branch from `main`
2. Make your changes
3. Verify everything passes locally:
   ```bash
   npm run lint                         # core + server + adapters + webview lint
   npm run check-types                  # TypeScript strict check across all packages
   npm run asyncapi:validate            # AsyncAPI spec validation
   npm run asyncapi:generate            # Regen core/src/messages.ts (must produce no git diff)
   npm run e2e:inventory                # Regen e2e/README.md (must produce no git diff)
   npm run build                        # esbuild (extension + CLI + hooks) + Vite (webview)
   npm test                             # Server vitest + webview vitest + package contract
   POKE_AGENTS_SPRITES=off npm run e2e -- e2e/tests/standalone --workers=1   # standalone Playwright specs
   ```
   CI runs these checks on every PR and push to `main`, plus the npm package smoke on Node 20. It runs only the standalone end-to-end specs; run the VS Code specs (`e2e/tests/claude`) yourself when you change the VS Code surface, because they open VS Code windows. The AsyncAPI and e2e inventory drift checks fail the build on any diff — always regen + commit the result.
4. Open a pull request against `main` with:
   - A **conventional commit PR title** (e.g. `feat: add zoom controls`, `fix: character freezing on terminal close`, `refactor: extract pathfinding module`). CI enforces this format — see [Conventional Commits](https://www.conventionalcommits.org/).
   - A clear description of what changed and why
   - How you tested the changes (steps to reproduce / verify)
   - **Screenshots or GIFs for any UI changes**

> **Note:** PRs are merged using **squash and merge** — all commits in your PR are combined into a single commit on `main`. Your PR title becomes the commit message, which is why the conventional commit format matters.

## Reporting Bugs

[Open a bug report](https://github.com/joshle298/poke-agents/issues/new?template=bug_report.yml) — the form will guide you through providing the details we need.

## Feature Requests

Have an idea? [Open a feature request](https://github.com/joshle298/poke-agents/issues/new?template=feature_request.yml) — the form will guide you through describing the problem and your proposed solution.

## Security Issues

Please report security vulnerabilities privately — see [SECURITY.md](SECURITY.md) for details.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.
