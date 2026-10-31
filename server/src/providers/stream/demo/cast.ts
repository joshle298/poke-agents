/**
 * The demo's sessions: synthetic names, repositories and models only (no real
 * people, companies or transcripts). Ids look like Conductor's UUIDs so every
 * code path treats them as it treats real sessions.
 */

import type { DemoSessionSpec } from './world.js';

const sessionId = (n: number): string => `5e55de00-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspaceId = (n: number): string => `0000de00-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Every session the story uses, by role. */
export const DEMO_IDS = {
  lead: sessionId(1),
  prototype: sessionId(2),
  alerts: sessionId(3),
  deps: sessionId(4),
  copy: sessionId(5),
  migration: sessionId(11),
  flaky: sessionId(12),
  docs: sessionId(13),
  review: sessionId(14),
  perf: sessionId(15),
} as const;

export type DemoRole = keyof typeof DEMO_IDS;

/** The workers the Lead spawns, in spawn order. */
export const DEMO_WORKERS = ['migration', 'flaky', 'docs', 'review', 'perf'] as const;
export type DemoWorker = (typeof DEMO_WORKERS)[number];

const CURSOR_CONTEXT_WINDOW = 200_000;

/** Pools for generated history and replies, per session. */
export interface DemoPools {
  files: readonly string[];
  commands: readonly string[];
  patterns: readonly string[];
  notes: readonly string[];
  followUps: readonly string[];
}

export interface DemoCastMember {
  spec: DemoSessionSpec;
  pools: DemoPools;
}

export const DEMO_CAST: Record<DemoRole, DemoCastMember> = {
  lead: {
    spec: {
      id: DEMO_IDS.lead,
      label: 'Release v2 orchestration',
      workspace: { id: workspaceId(141), name: 'release-v2', number: 141, repo: 'example-org/web' },
      model: 'claude-opus-5-5[1m]',
      harness: 'claude',
      prompt:
        'Ship v2. Split the work into parallel sessions (the accounts migration, the flaky tests, the docs, the PR #42 review and a perf pass), keep docs/RELEASE_PLAN.md current, and tag a release candidate once every track reports green.',
      present: true,
      status: 'working',
      messageCount: 312,
      contextTokens: 384_000,
    },
    pools: {
      files: [
        'docs/RELEASE_PLAN.md',
        'CHANGELOG.md',
        '.github/workflows/release.yml',
        'package.json',
        'src/app/routes.ts',
      ],
      commands: [
        'gh pr list --label v2 --state open',
        'git log --oneline -12',
        'npm run typecheck',
        'gh run list --workflow release.yml -L 5',
      ],
      patterns: ['TODO\\(v2\\)', 'plan_tier', 'featureFlags.v2'],
      notes: [
        'Five tracks are left before the release candidate: migration, flaky tests, docs, the PR #42 review and a perf pass.',
        'The pricing prototype is merged behind a flag, so its session can go to the PC.',
        'CI is green on main; the release workflow only needs the tag.',
        'RELEASE_PLAN.md now lists an owner session for every track.',
      ],
      followUps: [
        'Keep the plan doc short, one line per track.',
        'Make sure the docs mention the plan_tier rename.',
      ],
    },
  },
  prototype: {
    spec: {
      id: DEMO_IDS.prototype,
      label: 'Prototype pricing page',
      workspace: {
        id: workspaceId(133),
        name: 'pricing-prototype',
        number: 133,
        repo: 'example-org/web',
      },
      model: 'claude-opus-5-5',
      harness: 'claude',
      leadId: DEMO_IDS.lead,
      prompt:
        'Prototype the new pricing page behind the pricing-v2 flag: three plan cards, a monthly/yearly toggle, and no backend changes.',
      present: true,
      status: 'idle',
      messageCount: 214,
      contextTokens: 236_000,
      idleMinutes: 34,
    },
    pools: {
      files: [
        'src/pricing/PricingPage.tsx',
        'src/pricing/PlanCard.tsx',
        'src/flags.ts',
        'src/pricing/pricing.test.tsx',
      ],
      commands: ['npm run dev -- --port 3001', 'npx vitest run src/pricing', 'npm run lint'],
      patterns: ['pricing-v2', 'PlanCard'],
      notes: [
        'The three plan cards share one component; the yearly toggle only changes the price line.',
        'Everything sits behind pricing-v2, off by default.',
        'Snapshot tests cover both billing periods.',
      ],
      followUps: ['Use the existing button styles.', 'Keep the copy as placeholders for now.'],
    },
  },
  alerts: {
    spec: {
      id: DEMO_IDS.alerts,
      label: 'Triage nightly alerts',
      workspace: {
        id: workspaceId(138),
        name: 'alerts-triage',
        number: 138,
        repo: 'example-org/infra',
      },
      model: 'gpt-6.1-sol',
      harness: 'codex',
      prompt:
        "Go through last night's alerts, group them by cause, fix what is ours and open issues for the rest.",
      present: true,
      status: 'working',
      // Lv 15: a few more items and it evolves (Lv 16).
      messageCount: 436,
      contextTokens: 148_000,
    },
    pools: {
      files: [
        'runbooks/api-5xx.md',
        'k8s/api/deployment.yaml',
        'alerts/rules.yaml',
        'k8s/worker/cronjob.yaml',
      ],
      commands: [
        'kubectl -n api get pods',
        'kubectl -n worker get cronjobs',
        'gh issue list --label alert',
        'promtool check rules alerts/rules.yaml',
      ],
      patterns: ['readinessProbe', 'for: 5m', 'backoffLimit'],
      notes: [
        'The disk alert on worker-3 was a log rotation lag; it cleared on its own.',
        'Two pages came from the same flapping rule; it now waits 5 minutes before firing.',
        'The cron failures were a missing secret in staging only.',
      ],
      followUps: ['Ignore the staging-only alerts.', 'Open one issue per cause, not per alert.'],
    },
  },
  deps: {
    spec: {
      id: DEMO_IDS.deps,
      label: 'Dependency bumps',
      workspace: { id: workspaceId(137), name: 'deps-bump', number: 137, repo: 'example-org/api' },
      model: 'claude-sonnet-5',
      harness: 'claude',
      prompt:
        'Bump the minor and patch versions of our dependencies, run the full test suite, and list anything that needs a closer look.',
      present: true,
      status: 'idle',
      messageCount: 88,
      contextTokens: 96_000,
      idleMinutes: 52,
      pinned: true,
    },
    pools: {
      files: ['package.json', 'package-lock.json', 'src/server.ts', 'test/setup.ts'],
      commands: ['npm outdated', 'npm update', 'npm test', 'npm audit --omit=dev'],
      patterns: ['"fastify"', 'deprecated'],
      notes: [
        '14 packages moved; none of them is a major.',
        'The test suite passes after the bumps; one deprecation warning from the logger.',
        'npm audit reports nothing for production dependencies.',
      ],
      followUps: ['Leave the ORM alone this round.', 'Note the logger deprecation in the PR.'],
    },
  },
  copy: {
    spec: {
      id: DEMO_IDS.copy,
      label: 'Onboarding copy tweaks',
      workspace: {
        id: workspaceId(136),
        name: 'onboarding-copy',
        number: 136,
        repo: 'example-org/web',
      },
      model: 'composer-2',
      harness: 'cursor',
      contextWindow: CURSOR_CONTEXT_WINDOW,
      prompt: 'Tighten the onboarding checklist copy: shorter steps, no jargon, same structure.',
      present: true,
      status: 'idle',
      messageCount: 42,
      contextTokens: 31_000,
      idleMinutes: 186,
      hidden: true,
    },
    pools: {
      files: ['src/onboarding/Checklist.tsx', 'src/onboarding/copy.ts', 'src/i18n/en.json'],
      commands: ['npm run lint', 'npx vitest run src/onboarding'],
      patterns: ['checklist.step', 'onboarding.'],
      notes: [
        'Every step now fits on one line.',
        'Replaced "workspace provisioning" with "setting up your space".',
      ],
      followUps: ['Keep the step count at five.'],
    },
  },
  migration: {
    spec: {
      id: DEMO_IDS.migration,
      label: 'Write migration',
      workspace: {
        id: workspaceId(142),
        name: 'v2-migration',
        number: 142,
        repo: 'example-org/api',
      },
      model: 'gpt-6.1-sol',
      harness: 'codex',
      leadId: DEMO_IDS.lead,
      prompt:
        'Write the v2 accounts migration: add accounts.plan_tier, backfill it from plans in batches, keep it reversible, and dry-run it against the staging copy. Report back when the tests pass.',
      present: false,
      status: 'idle',
      messageCount: 0,
      contextTokens: 21_000,
    },
    pools: {
      files: [
        'db/schema.sql',
        'db/migrations/0042_v2_accounts.sql',
        'test/db/accounts.test.ts',
        'src/models/account.ts',
      ],
      commands: [
        'npm run db:migrate -- --dry-run',
        'npm run test:db -- accounts',
        'ls db/migrations | tail -n 4',
      ],
      patterns: ['plan_tier', 'CREATE INDEX'],
      notes: [
        'The backfill runs in 5k batches and can resume.',
        'The down step drops the column and the index.',
        'Dry run on the staging copy is clean.',
      ],
      followUps: [],
    },
  },
  flaky: {
    spec: {
      id: DEMO_IDS.flaky,
      label: 'Fix flaky tests',
      workspace: {
        id: workspaceId(143),
        name: 'flaky-tests',
        number: 143,
        repo: 'example-org/web',
      },
      model: 'claude-sonnet-5',
      harness: 'claude',
      leadId: DEMO_IDS.lead,
      prompt:
        'test/session-cache.test.ts fails about 1 run in 10 on CI. Find the cause, fix it, and prove it with 20 green runs in a row.',
      present: false,
      status: 'idle',
      messageCount: 0,
      contextTokens: 26_000,
    },
    pools: {
      files: ['src/session/cache.ts', 'test/session-cache.test.ts', 'vitest.config.ts'],
      commands: [
        'npx vitest run test/session-cache.test.ts',
        'npx vitest run --reporter=dot',
        'npm run test:ci',
      ],
      patterns: ['Date.now', 'ttlMs'],
      notes: [
        'The cache read the wall clock twice per lookup; an entry could expire in between.',
        'The test now injects a fake clock.',
      ],
      followUps: [],
    },
  },
  docs: {
    spec: {
      id: DEMO_IDS.docs,
      label: 'Update docs',
      workspace: { id: workspaceId(144), name: 'v2-docs', number: 144, repo: 'example-org/docs' },
      model: 'composer-2',
      harness: 'cursor',
      contextWindow: CURSOR_CONTEXT_WINDOW,
      leadId: DEMO_IDS.lead,
      prompt:
        'Update the docs for v2: the migration guide for /v2/accounts and a changelog entry. Keep every example copy-pasteable.',
      present: false,
      status: 'idle',
      messageCount: 0,
      contextTokens: 18_000,
    },
    pools: {
      files: ['docs/guides/migrate-to-v2.md', 'CHANGELOG.md', 'docs/api/accounts.md'],
      commands: ['npm run docs:check-links', 'npm run docs:build'],
      patterns: ['/v1/accounts', 'plan:'],
      notes: [
        'The guide shows the plan to plan_tier rename with a before and after.',
        'All links resolve.',
      ],
      followUps: [],
    },
  },
  review: {
    spec: {
      id: DEMO_IDS.review,
      label: 'Review PR #42',
      workspace: {
        id: workspaceId(145),
        name: 'pr-42-review',
        number: 145,
        repo: 'example-org/api',
      },
      model: 'claude-opus-5-5',
      harness: 'claude',
      leadId: DEMO_IDS.lead,
      prompt:
        'Review PR #42 (the accounts v2 serializer). Check API compatibility and test coverage, then leave a review.',
      present: false,
      status: 'idle',
      messageCount: 0,
      contextTokens: 34_000,
    },
    pools: {
      files: [
        'src/serializers/account.ts',
        'test/serializers/account.test.ts',
        'docs/api/accounts.md',
      ],
      commands: ['gh pr view 42 --json title,files', 'gh pr checks 42', 'gh pr diff 42'],
      patterns: ['plan:', 'plan_tier'],
      notes: [
        'The serializer tests cover both field names.',
        'CI on the PR is green apart from a lint warning.',
      ],
      followUps: [],
    },
  },
  perf: {
    spec: {
      id: DEMO_IDS.perf,
      label: 'Perf pass',
      workspace: { id: workspaceId(146), name: 'perf-pass', number: 146, repo: 'example-org/web' },
      model: 'grok-4.7',
      harness: 'cursor',
      contextWindow: CURSOR_CONTEXT_WINDOW,
      leadId: DEMO_IDS.lead,
      prompt:
        'Do a performance pass on /dashboard before the release: measure, fix the biggest wins, measure again, and report the numbers.',
      present: false,
      status: 'idle',
      messageCount: 0,
      contextTokens: 24_000,
    },
    pools: {
      files: [
        'src/dashboard/UsageChart.tsx',
        'src/dashboard/api.ts',
        'vite.config.ts',
        'src/settings/UsagePanel.tsx',
      ],
      commands: [
        'npx lighthouse http://localhost:3000/dashboard --only-categories=performance --quiet',
        'npm run build',
        'npx source-map-explorer dist/assets/index.js',
      ],
      patterns: ['useEffect', 'date-fns/locale'],
      notes: [
        'The chart re-rendered on every poll; the series is memoized now.',
        'Two components fetched the same usage endpoint; they share one request.',
      ],
      followUps: [],
    },
  },
};

/** Specs in office order (the order agents are first considered). */
export const DEMO_SPECS: readonly DemoSessionSpec[] = (
  ['prototype', 'lead', 'alerts', 'deps', 'copy', ...DEMO_WORKERS] as const
).map((role) => DEMO_CAST[role].spec);
