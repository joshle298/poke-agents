interface ChangelogSection {
  title: string;
  items: string[];
}

interface ChangelogContributor {
  name: string;
  url: string;
  description: string;
}

interface ChangelogEntry {
  version: string;
  sections: ChangelogSection[];
  contributors: ChangelogContributor[];
}

/** Extract "major.minor" from a semver string (e.g. "1.1.1" → "1.1") */
export function toMajorMinor(version: string): string {
  const parts = version.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : version;
}

/**
 * What the version label does when the office loads: `notice` ("Updated to
 * vX!") when this host last saw another version, `record` on a first run
 * (nothing was updated, so the version is recorded without a notice), or
 * `none` once this version was seen.
 */
export function versionNotice(
  currentVersion: string,
  lastSeenVersion: string,
): 'notice' | 'record' | 'none' {
  if (!currentVersion) return 'none';
  if (!lastSeenVersion) return 'record';
  return toMajorMinor(currentVersion) === lastSeenVersion ? 'none' : 'notice';
}

export const CHANGELOG_REPO_URL = 'https://github.com/joshle298/poke-agents';

/** Newest first. Entries before 0.1 are the Pixel Agents releases Poke Agents
 *  is built on. */
export const changelogEntries: ChangelogEntry[] = [
  {
    version: '0.3',
    sections: [
      {
        title: 'Features',
        items: [
          'The Pokémon town: workers in the Lab, idle ones in the tall grass, fainted ones in the Pokémon Center beds',
          'Sounds: each Pokémon cries when its session needs you, faints, arrives or evolves, plus original chiptune effects',
          'The Jukebox, with Poke Agents Radio: 12 freely licensed original tracks, or your own music',
          'The Mac app, with notifications and a Dock badge for sessions that need you',
          'Demo mode (--demo or npm run demo): a scripted office of synthetic sessions, no Conductor account needed',
        ],
      },
      {
        title: 'Changes',
        items: [
          'A new app icon, Promptling, and an original capsule for throws, recalls and messages',
          'New flags --no-sounds and --no-radio',
          'Working sessions read Working, fainted Pokémon turn grey, and a Lead with many sessions keeps them in place',
        ],
      },
    ],
    contributors: [
      {
        name: '@joshle298',
        url: 'https://github.com/joshle298',
        description: 'Poke Agents: the town, sounds, the Jukebox, the Mac app and the demo',
      },
    ],
  },
  {
    version: '0.2',
    sections: [
      {
        title: 'Features',
        items: [
          'Chat tab in the Pokédex: the conversation as one thread, Load earlier for older messages, and a reply box (Enter sends, Shift+Enter adds a line)',
          'Pending questions show with their options; Reply with this option sends the option as a normal message',
          'Sessions walk in at their real level, and tool steps read like "Bash · 41s"',
          'PC Box portraits survive a reload; --claude agents level up from their tool calls',
          'Settings → About & credits says what Poke Agents is',
        ],
      },
      {
        title: 'Fixes',
        items: [
          'The office refuses host names it does not know (DNS rebinding), and --open keeps the token off the browser command line',
          'Withdraw keeps a session in the office, and "All" in Sessions means the last 30 days instead of 1 hour',
          'Closing the Pokédex releases its fast polling; rate limits and busy workspaces no longer starve working sessions',
          'Short turns show a working burst, sessions already waiting on you do not chime at startup, and seats survive restarts',
          'Escape closes only the window on top, and Enter that confirms an IME composition no longer sends',
          'A session that returns during its recall comes back, and a spawned session shows its name once',
        ],
      },
    ],
    contributors: [
      {
        name: '@joshle298',
        url: 'https://github.com/joshle298',
        description: 'Poke Agents: the polish pass against real Conductor sessions',
      },
    ],
  },
  {
    version: '0.1',
    sections: [
      {
        title: 'Features',
        items: [
          'Conductor cloud sessions appear live in the office, each as a Pokémon that keeps its species',
          'Levels and evolution at Lv 16 and Lv 36, plus status conditions: SLP asleep, FNT fainted on an error, ! when a session needs you',
          'Leads (sessions that spawned others) are legendaries, linked to their sessions; messages fly between sessions with a short preview',
          'Pokédex panel: task, recent replies and messages, with Open in Conductor, Send message, Revive, Stop, Deposit in PC, Hide and Pin',
          'PC Box for archived sessions, and a Sessions modal for scope, search, hide and pin',
          'Party bar, an optional battle log, and npm start to open the office in its own window',
        ],
      },
      {
        title: 'Changes',
        items: [
          'Conductor is on by default (--no-conductor turns it off); Claude Code tracking is opt-in with --claude',
          'The command is poke-agents, on fixed port 41510 so an installed web app keeps working',
          'Settings can turn the Pokémon theme off for the Pixel Agents look',
        ],
      },
    ],
    contributors: [
      {
        name: '@joshle298',
        url: 'https://github.com/joshle298',
        description: 'Poke Agents: Conductor sessions, the Pokémon theme and the desktop window',
      },
    ],
  },
  {
    version: '1.5',
    sections: [
      {
        title: 'Features',
        items: [
          'Embedded terminal in the browser: launch, watch and drive agents from npx pixel-agents',
          'Mobile web app: swipe between office and terminal, touch input, and a key bar above the keyboard',
          'Agent cards with mug shots and status, in VS Code and the browser',
          'Directories: launch agents into workspace folders or your own, with path suggestions and Areas',
          'Layout editor: Alt+drag copies, desks carry their items, stroke undo, and a colour eyedropper',
        ],
      },
      {
        title: 'Changes',
        items: [
          'Skip permissions is now a Settings toggle applied to every launch (off by default)',
          'Workspace folders and the standalone start directory are listed in the drawer only when turned on in Settings',
          'The standalone access token survives restarts; --rotate-token replaces it',
        ],
      },
    ],
    contributors: [
      {
        name: '@pablodelucca',
        url: 'https://github.com/pablodelucca',
        description:
          'Embedded terminal, mobile web app, agent cards, Directories, and layout editor upgrades',
      },
    ],
  },
  {
    version: '1.4',
    sections: [
      {
        title: 'Features',
        items: [
          'Claude Code Agent Teams visualization with lead badges, role labels, and coordinated lifecycle',
          'Claude Code 2.1.220 support: named spawns become seated teammates, unnamed spawns stay watched sub-agents',
          'Context gauge on every agent, sized to the model its session runs',
          'Animated pets with saved placement, petting interactions, and external pet packs',
          'Auto-tiling carpets with color controls, painting tools, undo, and persistence',
          'Workspace Areas that map folders to office zones and guide agent seating',
          'Optional settings to show the panel and spawn an agent automatically at startup',
        ],
      },
      {
        title: 'Standalone and Architecture',
        items: [
          'Run the browser office with npx pixel-agents',
          'Layered architecture with a shared runtime, provider contracts, and transport adapters',
          'Multi-server hook fan-out lets VS Code and standalone run together',
          'Published AsyncAPI WebSocket contract with generated TypeScript bindings',
        ],
      },
      {
        title: 'Fixes',
        items: [
          'Preserve agent tracking across terminal moves and align teammate lifecycle behavior',
          'Honor explicit standalone ports and restore browser-mock hot reload',
          'Improve Areas seating for custom-named folders and polish editor layouts',
          'Fix duplicate agent adoption on Windows and a /clear session reassignment race',
          'Render restored agents reliably, in VS Code and on standalone reconnect',
          'Surface hook install failures instead of logging false success',
          'Fix the Windows build for paths with spaces and keep JSONL discovery active with hooks',
        ],
      },
      {
        title: 'Testing and Release Infrastructure',
        items: [
          'Comprehensive narrated Playwright e2e coverage for VS Code and standalone',
          'Verified npm packaging and provenance-ready publishing pipeline',
        ],
      },
    ],
    contributors: [
      {
        name: '@itsManeka',
        url: 'https://github.com/itsManeka',
        description: 'Animated pet system, bundled pet sprites, and pet interactions',
      },
      {
        name: '@NNTin',
        url: 'https://github.com/NNTin',
        description: 'Carpet system and foundational Playwright e2e infrastructure',
      },
      {
        name: '@balgaly',
        url: 'https://github.com/balgaly',
        description: 'Automatic panel display and agent startup settings',
      },
      {
        name: '@elietwd',
        url: 'https://github.com/elietwd',
        description: 'Cross-platform Windows build script and server test isolation',
      },
      {
        name: '@snvtac',
        url: 'https://github.com/snvtac',
        description: 'Workspace JSONL discovery with hooks enabled',
      },
      {
        name: '@bezzborodth-tech',
        url: 'https://github.com/bezzborodth-tech',
        description: 'Standalone rendering fix for agents that already exist on connect',
      },
      {
        name: '@Ralphive',
        url: 'https://github.com/Ralphive',
        description: 'Restored-agent rendering fix',
      },
      {
        name: '@srasantos',
        url: 'https://github.com/srasantos',
        description: 'Reported the hook-install and restored-agent rendering bugs',
      },
      {
        name: '@ErickGross-19',
        url: 'https://github.com/ErickGross-19',
        description: 'Early Agent Teams implementation that informed the shipped design',
      },
      {
        name: '@ZenidX',
        url: 'https://github.com/ZenidX',
        description: 'Early Agent Teams implementation that informed the shipped design',
      },
      {
        name: '@pablodelucca',
        url: 'https://github.com/pablodelucca',
        description:
          'Claude 2.1.220 sub-agents and teammates, context gauge, Workspace Areas, layout-editor polish, narrated e2e review',
      },
      {
        name: '@florintimbuc',
        url: 'https://github.com/florintimbuc',
        description:
          'Architecture, Agent Teams, standalone, multi-server, file-watcher and CI hardening, e2e, and release work',
      },
    ],
  },
  {
    version: '1.3',
    sections: [
      {
        title: 'Features',
        items: [
          'Hooks-first session management with dual-mode architecture (hooks + heuristic fallback)',
          'Claude Code hooks for instant agent status detection',
          'External session support and Agent tool recognition',
          'Multi-root workspace agent detection across all workspace folders',
          'Load custom characters from external asset directories',
          'Tailwind CSS v4 migration for the webview UI',
        ],
      },
      {
        title: 'Fixes',
        items: [
          'Prevent duplicate restores, fix tool status reconnect, improve agent tool detection',
        ],
      },
      {
        title: 'Maintenance',
        items: [
          'Add shared/ to lint, format, and lint-staged',
          'Dependabot dev-dependency group bumps',
        ],
      },
    ],
    contributors: [
      {
        name: '@drewf',
        url: 'https://github.com/drewf',
        description: 'External session support and Agent tool recognition',
      },
      {
        name: '@Commandershadow9',
        url: 'https://github.com/Commandershadow9',
        description: 'Multi-root workspace agent detection',
      },
      {
        name: '@mitre88',
        url: 'https://github.com/mitre88',
        description: 'Duplicate restore, tool status reconnect, tool detection fixes',
      },
      {
        name: '@noam971',
        url: 'https://github.com/noam971',
        description: 'Duplicate restore, tool status reconnect, tool detection fixes',
      },
      {
        name: '@itsManeka',
        url: 'https://github.com/itsManeka',
        description: 'Custom characters from external asset directories',
      },
      {
        name: '@pablodelucca',
        url: 'https://github.com/pablodelucca',
        description: 'Claude Code hooks integration, Tailwind v4 migration',
      },
      {
        name: '@NNTin',
        url: 'https://github.com/NNTin',
        description: 'Claude Code hooks integration, Tailwind v4 migration',
      },
      {
        name: '@florintimbuc',
        url: 'https://github.com/florintimbuc',
        description: 'Hooks-first dual-mode architecture, review coordination',
      },
    ],
  },
  {
    version: '1.2',
    sections: [
      {
        title: 'Features',
        items: [
          'Bypass permissions mode — right-click "+ Agent" to skip tool approvals',
          'External asset packs — load furniture from user-defined directories',
          'Improved seating, sub-agent spawning, and background agent support',
          'Always show overlay setting for agent labels',
          'Agent connection diagnostics and JSONL parser resilience',
          'Browser preview mode for development and review',
        ],
      },
      {
        title: 'Fixes',
        items: ['Agents not appearing on Linux Mint/macOS when no folder is open'],
      },
      {
        title: 'Testing',
        items: ['Playwright e2e tests with mock Claude CLI'],
      },
      {
        title: 'Maintenance',
        items: [
          'Bump Vite 8.0, ESLint 10, and various dependency updates',
          'CI improvements for Dependabot and badge updates',
        ],
      },
    ],
    contributors: [
      {
        name: '@marctebo',
        url: 'https://github.com/marctebo',
        description: 'External asset packs support',
      },
      {
        name: '@dankadr',
        url: 'https://github.com/dankadr',
        description: 'Bypass permissions mode',
      },
      {
        name: '@d4rkd0s',
        url: 'https://github.com/d4rkd0s',
        description: 'Linux/macOS fix for no-folder workspaces',
      },
      {
        name: '@daniel-dallimore',
        url: 'https://github.com/daniel-dallimore',
        description: 'Always show overlay setting',
      },
      {
        name: '@NNTin',
        url: 'https://github.com/NNTin',
        description: 'Playwright e2e tests, browser preview mode',
      },
      {
        name: '@florintimbuc',
        url: 'https://github.com/florintimbuc',
        description: 'Agent diagnostics, JSONL resilience, CI improvements',
      },
    ],
  },
];
