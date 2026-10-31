/**
 * The demo's story, as queues of actions per session plus a few timed steps.
 *
 * Round 0 (the first five minutes) is fixed, whatever the seed: the Lead
 * ("Release v2 orchestration") spawns five workers over ~20 s, they work and
 * report back, "Fix flaky tests" faints and the Lead revives it, "Update docs"
 * finishes early and falls asleep, "Review PR #42" waits on a question,
 * "Triage nightly alerts" evolves, and the finished pricing prototype is
 * archived. Later rounds give every worker a new task (the seed picks the
 * details) with the same beats, so the office keeps going.
 */

import type { StreamSessionDetail } from '../../../../../core/src/provider.js';
import { formatConductorToolStatus } from '../conductor/tools.js';
import {
  DEMO_CAST,
  DEMO_IDS,
  DEMO_SPECS,
  DEMO_WORKERS,
  type DemoPools,
  type DemoWorker,
} from './cast.js';
import {
  DEMO_BACKSTORY_MAX_ENTRIES,
  DEMO_BACKSTORY_SPAN_MIN,
  DEMO_CYCLE_SEC,
} from './constants.js';
import { deriveRandom, type Random } from './random.js';
import type { DemoAction, DemoReplies, DemoSessionSpec, DemoWorld } from './world.js';

const MS_PER_SEC = 1_000;

// ── Action builders ───────────────────────────────────────────

const read = (file: string, secs = 2, tokens?: number): DemoAction => ({
  kind: 'tool',
  name: 'Read',
  input: { file_path: file },
  secs,
  tokens,
});

const edit = (file: string, secs = 2.5, tokens?: number): DemoAction => ({
  kind: 'tool',
  name: 'Edit',
  input: { file_path: file },
  secs,
  tokens,
});

const write = (file: string, secs = 3): DemoAction => ({
  kind: 'tool',
  name: 'Write',
  input: { file_path: file },
  secs,
});

const bash = (command: string, secs = 3, tokens?: number): DemoAction => ({
  kind: 'tool',
  name: 'Bash',
  input: { command },
  secs,
  tokens,
});

const grep = (pattern: string, path: string, secs = 1.5, tokens?: number): DemoAction => ({
  kind: 'tool',
  name: 'Grep',
  input: { pattern, path },
  secs,
  tokens,
});

const say = (text: string, secs?: number): DemoAction => ({ kind: 'say', text, secs });
const wait = (secs: number): DemoAction => ({ kind: 'wait', secs });
const end: DemoAction = { kind: 'end' };

function quoted(text: string): string {
  return `"${text.replace(/["\\$`]/g, '\\$&')}"`;
}

/** The Conductor CLI call, then the message itself. */
function message(to: string, text: string, reply?: DemoAction[]): DemoAction[] {
  return [
    bash(`conductor message create --message ${quoted(text)} --session ${to}`, 1.2),
    { kind: 'send', to, text, reply },
  ];
}

/** A status check on another session. */
function check(target: string): DemoAction[] {
  return [bash(`conductor session status ${target}`, 1.2), { kind: 'watch', target }];
}

/** `conductor workspace create`, then the new session starts on `work`. */
function spawn(worker: DemoWorker, work: DemoAction[]): DemoAction[] {
  const spec = DEMO_CAST[worker].spec;
  return [
    bash(
      `conductor workspace create --repo ${spec.workspace.repo} --name ${spec.workspace.name} --model ${spec.model} --message ${quoted(spec.prompt)}`,
      1.2,
    ),
    { kind: 'spawn', child: spec.id, work },
  ];
}

/** The Lead's answer to a report: tick the plan, say so. */
function leadAck(text: string, more: DemoAction[] = []): DemoAction[] {
  return [edit('docs/RELEASE_PLAN.md', 1.5), say(text, 1), ...more, end];
}

const L = DEMO_IDS.lead;

// ── Round 0: fixed ────────────────────────────────────────────

function migrationWork(): DemoAction[] {
  return [
    read('db/schema.sql'),
    bash('ls db/migrations | tail -n 4', 1.2),
    say('The newest migration is 0041. Writing 0042 with an up and a down step.'),
    write('db/migrations/0042_v2_accounts.sql', 3.5),
    edit('db/migrations/0042_v2_accounts.sql', 2),
    bash('npm run db:migrate -- --dry-run', 5),
    say('Dry run is clean: 18,240 rows backfill in 4 batches.'),
    bash('npm run test:db -- accounts', 6),
    say('One failure: the down step left the index behind.'),
    edit('db/migrations/0042_v2_accounts.sql', 2.5),
    bash('npm run test:db -- accounts', 5),
    ...message(
      L,
      'Migration 0042 is ready: adds accounts.plan_tier, backfills in 5k batches, and the down step is tested. Dry run on the staging copy is clean.',
      leadAck('Migration track is done.', [
        ...message(
          DEMO_IDS.migration,
          'Great. Add an index on plan_tier too; the billing job filters on it.',
          [
            read('src/models/account.ts'),
            edit('db/migrations/0042_v2_accounts.sql', 2.5),
            bash('npm run test:db -- accounts', 5),
            say(
              'Index added with CREATE INDEX CONCURRENTLY, so the backfill never locks the table.',
            ),
            ...message(L, 'Index on accounts.plan_tier added; DB tests pass.', [
              say('Noted in the plan.', 1),
              end,
            ]),
            end,
          ],
        ),
      ]),
    ),
    end,
  ];
}

function flakyWork(): DemoAction[] {
  return [
    bash('npx vitest run test/session-cache.test.ts --repeat 10', 6),
    say('3 of 10 runs failed: an entry expires between the write and the read.'),
    read('src/session/cache.ts'),
    grep('Date.now', 'src/session'),
    say('The cache reads the wall clock twice per lookup. Injecting one clock.'),
    edit('src/session/cache.ts', 3),
    edit('test/session-cache.test.ts', 2.5),
    bash('npx vitest run test/session-cache.test.ts --repeat 20', 9),
    {
      kind: 'fail',
      error: 'Test runner crashed: a worker ran out of memory (exit code 137).',
      revive: [
        bash('npx vitest run test/session-cache.test.ts --repeat 20 --maxWorkers=2', 8),
        say('20 of 20 runs pass.'),
        ...message(
          L,
          'Flaky test fixed: the cache read the clock twice per lookup. 20/20 runs green with --maxWorkers=2.',
          leadAck('Flaky tests are fixed.'),
        ),
        end,
      ],
    },
  ];
}

function docsWork(): DemoAction[] {
  return [
    read('docs/guides/migrate-to-v2.md'),
    grep('/v1/accounts', 'docs'),
    edit('docs/guides/migrate-to-v2.md', 3),
    say('Added a before and after for the plan to plan_tier rename.'),
    edit('CHANGELOG.md', 2),
    bash('npm run docs:check-links', 3),
    say('All 214 links resolve.'),
    ...message(
      L,
      'Docs are ready: the v2 migration guide covers the plan_tier rename, and the changelog has an entry.',
      leadAck('Docs track is done.'),
    ),
    end,
  ];
}

/** What the reviewer does once its question is answered. */
function reviewAfter(pr: number, answer: string): DemoAction[] {
  const file = `.context/review-pr-${pr}.md`;
  const lower = answer.toLowerCase();
  if (lower.startsWith('approve') || lower.startsWith('yes') || lower.startsWith('accept')) {
    return [
      say(`Approving PR #${pr}.`),
      write(file, 2),
      bash(`gh pr review ${pr} --approve --body-file ${file}`, 2),
      ...message(L, `Approved PR #${pr}.`, leadAck(`PR #${pr} is approved.`)),
      end,
    ];
  }
  if (lower.startsWith('hold') || lower.startsWith('keep')) {
    return [
      say(`Holding PR #${pr} for now.`),
      bash(`gh pr comment ${pr} --body "Holding until after the release."`, 2),
      ...message(L, `PR #${pr} is on hold until after the release.`, leadAck('Noted.')),
      end,
    ];
  }
  return [
    say(`Going with: ${answer.length > 80 ? `${answer.slice(0, 79)}…` : answer}`),
    write(file, 2),
    bash(`gh pr review ${pr} --request-changes --body-file ${file}`, 2),
    ...message(
      L,
      `Reviewed PR #${pr} and requested changes: ${answer}. Tests cover the change.`,
      leadAck(`PR #${pr} has its review.`),
    ),
    end,
  ];
}

function reviewWork(): DemoAction[] {
  return [
    bash('gh pr view 42 --json title,files', 2),
    bash('gh pr diff 42', 2.5),
    read('src/serializers/account.ts'),
    grep('plan:', 'src'),
    read('test/serializers/account.test.ts'),
    say(
      'PR #42 renames plan to plan_tier in the public response, which breaks clients that already read v2.',
      1.5,
    ),
    {
      kind: 'ask',
      question:
        'PR #42 renames plan to plan_tier in the public /v2/accounts response. How should I review it?',
      header: 'Breaking change',
      options: [
        'Approve: v2 is allowed to break',
        'Request a one-release alias for plan',
        'Hold it until after the release',
      ],
      then: (answer) => reviewAfter(42, answer),
    },
  ];
}

function perfWork(): DemoAction[] {
  const lighthouse =
    'npx lighthouse http://localhost:3000/dashboard --only-categories=performance --quiet';
  return [
    bash(lighthouse, 6, 9_000),
    say('Baseline: LCP 3.1 s, TBT 410 ms. The usage chart re-renders on every poll.'),
    grep('useEffect', 'src/dashboard', 1.5, 6_000),
    read('src/dashboard/UsageChart.tsx', 2, 11_000),
    edit('src/dashboard/UsageChart.tsx', 3, 8_000),
    bash('npm run build', 5, 12_000),
    bash(lighthouse, 6, 9_000),
    ...message(
      L,
      'First win: the chart series is memoized. LCP 3.1 s to 2.4 s.',
      leadAck('Good progress on perf.', [
        ...message(DEMO_IDS.perf, 'Nice. /settings uses the same chart: check it too.', [
          read('src/settings/UsagePanel.tsx'),
          edit('src/settings/UsagePanel.tsx', 2.5),
          say('Same fix applied on /settings.'),
          end,
        ]),
      ]),
    ),
    read('src/dashboard/api.ts', 2, 14_000),
    say('Two components fetch the same usage endpoint.'),
    edit('src/dashboard/api.ts', 3, 10_000),
    bash('npx source-map-explorer dist/assets/index.js', 4, 22_000),
    say('date-fns ships every locale: 84 kB of the bundle.'),
    edit('vite.config.ts', 2, 8_000),
    bash('npm run build', 5, 12_000),
    bash(lighthouse, 6, 16_000),
    read('reports/lighthouse.json', 2, 18_000),
    { kind: 'compact', secs: 4, to: 46_000 },
    bash(lighthouse, 6, 9_000),
    say('Final numbers: LCP 3.1 s to 1.8 s, TBT 410 ms to 160 ms, bundle 84 kB smaller.'),
    ...message(
      L,
      'Perf pass done: LCP 3.1 s to 1.8 s, TBT 410 ms to 160 ms, bundle 84 kB smaller.',
      leadAck('Perf track is done.'),
    ),
    end,
  ];
}

const ROUND0_WORK: Record<DemoWorker, () => DemoAction[]> = {
  migration: migrationWork,
  flaky: flakyWork,
  docs: docsWork,
  review: reviewWork,
  perf: perfWork,
};

function leadIntro(): DemoAction[] {
  return [
    read('docs/RELEASE_PLAN.md', 1.5),
    say(
      'Five tracks stand between us and the release candidate. One session each: migration, flaky tests, docs, the PR #42 review and a perf pass.',
      1,
    ),
    ...DEMO_WORKERS.flatMap((worker, i) => [
      ...(i > 0 ? [wait(2.5)] : []),
      ...spawn(worker, ROUND0_WORK[worker]()),
    ]),
    edit('docs/RELEASE_PLAN.md', 2),
    say('Every track has a session. I will check in as they report.'),
    ...check(DEMO_IDS.migration),
    end,
  ];
}

/** "Triage nightly alerts": fourteen more feed items reach Lv 16 and it
 *  evolves (on the rules Read, about 57 s in). */
function alertsRound0(): DemoAction[] {
  return [
    bash(`kubectl -n api logs deploy/api --since=10h | grep -c " 5[0-9][0-9] "`, 3),
    say('412 5xx responses overnight, almost all between 02:10 and 02:25.'),
    read('runbooks/api-5xx.md'),
    wait(12),
    bash('kubectl -n api rollout history deploy/api', 2.5),
    say(
      'They line up with the 02:10 deploy: the readiness probe passed before the cache warmed.',
      1.5,
    ),
    wait(28),
    edit('k8s/api/deployment.yaml', 3),
    bash('kubectl diff -f k8s/api/deployment.yaml', 3),
    say('The probe now waits for /readyz, which checks the cache.'),
    read('alerts/rules.yaml'),
    say('Two pages came from one flapping rule. Giving it a 5 minute window.'),
    wait(4),
    edit('alerts/rules.yaml', 2.5),
    bash('promtool check rules alerts/rules.yaml', 2),
    wait(5),
    bash('gh issue create --title "api: 5xx burst during deploys" --label alert', 2),
    say('Filed one issue for the deploy burst; the other alerts were known flaps.'),
    end,
  ];
}

// ── Later rounds ──────────────────────────────────────────────

interface FollowUp {
  task: string;
  done: string;
}

const ROUND_TITLES = [
  'v2.1 follow-ups',
  'Hardening before GA',
  'Cleanup after the launch',
  'v2.2 groundwork',
];

const FOLLOW_UPS: Record<DemoWorker, readonly FollowUp[]> = {
  migration: [
    {
      task: 'Add a partial index for active accounts on plan_tier.',
      done: 'Partial index added; the billing query plan uses it.',
    },
    {
      task: 'Write the rollback runbook for migration 0042.',
      done: 'The rollback runbook is in docs/runbooks/0042-rollback.md, tried on the staging copy.',
    },
  ],
  flaky: [
    {
      task: 'The checkout e2e test times out now and then on CI. Same treatment: find it, fix it, 20 green runs.',
      done: 'Checkout e2e fixed: it slept for a fixed time; now it waits for the request. 20/20 green.',
    },
    {
      task: 'test/webhooks.test.ts is flaky under load. Find out why and fix it.',
      done: 'Webhooks test fixed: two tests shared a port. 20/20 green.',
    },
  ],
  docs: [
    {
      task: 'Document the new partial index in the API guide.',
      done: 'The API guide explains the plan_tier index and the billing query.',
    },
    {
      task: 'Add the rollback runbook to the docs navigation.',
      done: 'The runbook is linked from the operations section.',
    },
  ],
  review: [
    {
      task: 'Review PR #57 (rate limits for the accounts API).',
      done: 'PR #57 is reviewed.',
    },
    {
      task: 'Review PR #63 (webhook retries).',
      done: 'PR #63 is reviewed.',
    },
  ],
  perf: [
    {
      task: 'Same pass on /reports: measure, fix the biggest win, measure again.',
      done: '/reports LCP went from 2.7 s to 1.6 s: the table now renders only visible rows.',
    },
    {
      task: 'Check the p95 of /v2/accounts under load and fix the slowest query.',
      done: 'p95 for /v2/accounts dropped from 420 ms to 140 ms with one missing index.',
    },
  ],
};

const FLAKY_ERRORS = [
  'Test runner crashed: the browser process was killed (signal 9).',
  'Test run timed out after 600 s.',
];

const REVIEW_QUESTIONS: ReadonlyArray<{
  pr: number;
  question: string;
  header: string;
  options: readonly string[];
}> = [
  {
    pr: 57,
    question:
      'PR #57 lowers the default rate limit from 600 to 300 requests a minute. Should existing API keys get 300 too?',
    header: 'Rate limits',
    options: ['Yes, every key gets 300', 'Only new keys get 300', 'Keep 600 for now'],
  },
  {
    pr: 63,
    question: 'PR #63 retries failed webhooks for 24 h instead of 3 h. Accept the longer window?',
    header: 'Webhook retries',
    options: ['Accept 24 h', 'Ask for 12 h', 'Make it configurable per endpoint'],
  },
];

function pools(worker: DemoWorker | 'alerts' | 'deps'): DemoPools {
  return DEMO_CAST[worker].pools;
}

/** Common shape of a later-round task: look, change, check, report. */
function followUpWork(worker: DemoWorker, round: number, rng: Random): DemoAction[] {
  const p = pools(worker);
  const variant = (round - 1) % 2;
  const followUp = FOLLOW_UPS[worker][variant];
  const look: DemoAction[] = [
    read(rng.pick(p.files)),
    grep(rng.pick(p.patterns), 'src'),
    say(rng.pick(p.notes)),
    edit(rng.pick(p.files), rng.int(2, 4)),
  ];
  const report = message(L, followUp.done, leadAck('Noted in the plan.'));
  switch (worker) {
    case 'flaky':
      return [
        bash(rng.pick(p.commands), 6),
        ...look,
        bash(`${p.commands[0]} --repeat 20`, 8),
        {
          kind: 'fail',
          error: FLAKY_ERRORS[variant],
          revive: [bash(`${p.commands[0]} --repeat 20 --maxWorkers=2`, 7), ...report, end],
        },
      ];
    case 'review': {
      const q = REVIEW_QUESTIONS[variant];
      return [
        bash(`gh pr view ${q.pr} --json title,files`, 2),
        bash(`gh pr diff ${q.pr}`, 2.5),
        ...look.slice(0, 2),
        {
          kind: 'ask',
          question: q.question,
          header: q.header,
          options: q.options,
          then: (answer) => reviewAfter(q.pr, answer),
        },
      ];
    }
    case 'docs':
      return [...look, bash(rng.pick(p.commands), 3), ...report, end];
    case 'perf':
      return [
        bash(p.commands[0], 6),
        ...look,
        bash(rng.pick(p.commands), 5),
        read(rng.pick(p.files)),
        edit(rng.pick(p.files), 3),
        bash(p.commands[0], 6),
        ...report,
        end,
      ];
    case 'migration':
      return [...look, bash(rng.pick(p.commands), 5), say(rng.pick(p.notes)), ...report, end];
  }
}

function leadRound(round: number, world: DemoWorld, rng: Random): DemoAction[] {
  const title = ROUND_TITLES[(round - 1) % ROUND_TITLES.length];
  const actions: DemoAction[] = [
    { kind: 'user', text: `Next round: ${title}. Same five tracks, new tasks.` },
    read('docs/RELEASE_PLAN.md', 1.5),
    say(`Round ${round + 1}: ${title}. Handing out the next tasks.`, 1),
  ];
  for (const worker of DEMO_WORKERS) {
    const id = DEMO_CAST[worker].spec.id;
    const status = world.status(id);
    if (status === 'archived') continue;
    if (status === 'unborn') {
      actions.push(...spawn(worker, ROUND0_WORK[worker]()), wait(2));
      continue;
    }
    const followUp = FOLLOW_UPS[worker][(round - 1) % 2];
    actions.push(...message(id, followUp.task, followUpWork(worker, round, rng)), wait(2));
  }
  actions.push(say('Every track has its next task.'), end);
  return actions;
}

function alertsRound(rng: Random): DemoAction[] {
  const p = pools('alerts');
  return [
    bash(rng.pick(p.commands), 3),
    say(rng.pick(p.notes)),
    read(rng.pick(p.files)),
    wait(rng.int(6, 14)),
    grep(rng.pick(p.patterns), 'k8s'),
    edit(rng.pick(p.files), 3),
    bash(rng.pick(p.commands), 2.5),
    say('Triage done for this batch.'),
    end,
  ];
}

function depsTurn(rng: Random): DemoAction[] {
  const p = pools('deps');
  return [
    { kind: 'user', text: 'Renovate opened a few PRs. Check if any of them is risky.' },
    bash('npm outdated', 3),
    read(rng.pick(p.files)),
    bash('npm test', 6),
    say(rng.pick(p.notes)),
    end,
  ];
}

// ── Mid-round nudges ──────────────────────────────────────────

interface Nudge {
  /** Script seconds into the round. */
  at: number;
  worker: DemoWorker | 'alerts';
  /** Round 0 takes the first; later rounds alternate. */
  variants: ReadonlyArray<{ text: string; work: () => DemoAction[] }>;
}

const MIGRATION_NUDGES: Nudge['variants'] = [
  {
    text: 'Add the rollback steps to the PR description.',
    work: () => [
      bash('gh pr view --json body -q .body > .context/pr-body.md', 1.5),
      edit('.context/pr-body.md', 2),
      bash('gh pr edit --body-file .context/pr-body.md', 1.5),
      ...message(L, 'The PR description now has the rollback steps.', leadAck('Thanks.')),
      end,
    ],
  },
  {
    text: 'Double-check the backfill on the largest tenant.',
    work: () => [
      bash('npm run db:backfill -- --tenant largest --dry-run', 5),
      read('db/migrations/0042_v2_accounts.sql'),
      say('The largest tenant backfills in 11 batches, 40 s in total.'),
      ...message(L, 'Backfill on the largest tenant: 11 batches, about 40 s.', leadAck('Good.')),
      end,
    ],
  },
];

/** Small extra tasks that keep the office busy between the big beats. */
const NUDGES: readonly Nudge[] = [
  { at: 72, worker: 'migration', variants: MIGRATION_NUDGES },
  { at: 110, worker: 'migration', variants: [MIGRATION_NUDGES[1], MIGRATION_NUDGES[0]] },
  {
    at: 118,
    worker: 'perf',
    variants: [
      {
        text: 'Run the same pass on /reports.',
        work: () => [
          bash('npx lighthouse http://localhost:3000/reports --quiet', 6),
          read('src/reports/ReportsTable.tsx'),
          say('The table renders all 2,000 rows up front.'),
          edit('src/reports/ReportsTable.tsx', 3.5),
          bash('npm run build', 5),
          bash('npx lighthouse http://localhost:3000/reports --quiet', 6),
          ...message(
            L,
            '/reports LCP 2.7 s to 1.6 s: the table renders only the visible rows now.',
            leadAck('Perf is in good shape.'),
          ),
          end,
        ],
      },
      {
        text: 'Check the bundle once more after the merges.',
        work: () => [
          bash('npm run build', 5),
          bash('npx source-map-explorer dist/assets/index.js', 4),
          say('No new heavy dependencies since the last pass.'),
          ...message(L, 'Bundle is unchanged after the merges.', leadAck('Good.')),
          end,
        ],
      },
    ],
  },
  {
    at: 100,
    worker: 'flaky',
    variants: [
      {
        text: 'Look for other tests that read the wall clock.',
        work: () => [
          grep('Date.now', 'test'),
          read('test/rate-limit.test.ts'),
          edit('test/rate-limit.test.ts', 2.5),
          bash('npx vitest run test/rate-limit.test.ts --repeat 10', 6),
          ...message(
            L,
            'Two more tests read the wall clock; both use the fake clock now.',
            leadAck('Nice catch.'),
          ),
          end,
        ],
      },
      {
        text: 'Run the whole suite 5 times to be sure.',
        work: () => [
          bash('npm run test:ci -- --repeat 5', 9),
          say('5 of 5 full runs pass.'),
          ...message(L, 'Full suite: 5 of 5 runs green.', leadAck('Great.')),
          end,
        ],
      },
    ],
  },
  {
    at: 168,
    worker: 'alerts',
    variants: [
      {
        text: 'Another page came in: disk usage on worker-3.',
        work: () => [
          bash('kubectl -n worker exec worker-3 -- df -h /var/log', 2.5),
          say('Log rotation fell behind; /var/log is at 91%.'),
          read('k8s/worker/logrotate.yaml'),
          edit('k8s/worker/logrotate.yaml', 2.5),
          bash('kubectl apply -f k8s/worker/logrotate.yaml', 2),
          say('Rotation runs hourly now; usage is back to 40%.'),
          end,
        ],
      },
      {
        text: 'The certificate expiry alert fired for staging.',
        work: () => [
          bash('kubectl -n staging get certificate', 2),
          say('The staging certificate renews in 3 days; cert-manager is healthy.'),
          edit('alerts/rules.yaml', 2),
          say('The alert now fires at 7 days left instead of 14.'),
          end,
        ],
      },
    ],
  },
];

function scheduleNudges(world: DemoWorld, round: number): void {
  for (const nudge of NUDGES) {
    const variant = nudge.variants[round === 0 ? 0 : round % nudge.variants.length];
    world.at(at(round, nudge.at), (w) => {
      const id = DEMO_CAST[nudge.worker].spec.id;
      if (w.status(id) !== 'idle') return;
      if (nudge.worker === 'alerts') {
        // Not a Lead's worker: the user (on call) asks it.
        w.enqueue(id, [{ kind: 'user', text: variant.text }, ...variant.work()]);
        return;
      }
      w.enqueue(L, [...message(id, variant.text, variant.work()), end]);
    });
  }
}

// ── Timed steps ───────────────────────────────────────────────

/** The Lead notices a fainted worker and revives it. */
function reviveCheck(world: DemoWorld): void {
  const flaky = DEMO_IDS.flaky;
  if (world.status(flaky) !== 'error') return;
  world.enqueue(L, [
    ...check(flaky),
    say('Fix flaky tests fainted: its test run crashed. Asking it to retry with fewer workers.', 1),
    ...message(
      flaky,
      'continue: rerun the 20 runs with --maxWorkers=2; the fix itself looks right.',
    ),
    end,
  ]);
}

/** The Lead looks in on the reviewer and leaves the question to the user. */
function questionCheck(world: DemoWorld): void {
  const review = DEMO_IDS.review;
  if (world.status(review) !== 'asking' || world.status(L) !== 'idle') return;
  world.enqueue(L, [
    ...check(review),
    say('The PR review is waiting on a question for you. Leaving that call to you.', 1),
    end,
  ]);
}

/** Nobody answered the reviewer: the Lead decides so the release isn't blocked. */
function answerCheck(world: DemoWorld): void {
  const review = DEMO_IDS.review;
  if (world.status(review) !== 'asking') return;
  world.enqueue(L, [
    ...check(review),
    say(
      'The review is waiting on a decision. Taking the cautious option so the release keeps moving.',
      1,
    ),
    ...message(review, 'Request a one-release alias, then approve.'),
    end,
  ]);
}

function wrapUp(round: number): DemoAction[] {
  const tag = round === 0 ? 'v2.0.0-rc.1' : `v2.${round}.0-rc.1`;
  return [
    bash('gh pr list --label v2 --state open', 2),
    say('Every track reported. Tagging the release candidate.', 1),
    bash(`git tag ${tag} && git push origin ${tag}`, 2.5),
    say(`${tag} is tagged and the release workflow is running.`),
    end,
  ];
}

// ── The story ─────────────────────────────────────────────────

export interface DemoStory {
  specs: readonly DemoSessionSpec[];
  replies: DemoReplies;
  backstory: (spec: DemoSessionSpec, endAt: number) => StreamSessionDetail['entries'];
  /** Put the first round in motion (call once, after the world began). */
  start(world: DemoWorld): void;
}

const at = (round: number, secs: number): number => (round * DEMO_CYCLE_SEC + secs) * MS_PER_SEC;

function startRound(world: DemoWorld, round: number, seed: number): void {
  const rng = deriveRandom(seed, `round:${round}`);
  if (round === 0) {
    world.enqueue(L, leadIntro());
    world.enqueue(DEMO_IDS.alerts, alertsRound0());
    world.at(at(0, 24), (w) => {
      if (w.status(DEMO_IDS.prototype) === 'idle') w.archive(DEMO_IDS.prototype);
    });
  } else {
    world.enqueue(L, leadRound(round, world, rng));
    world.at(at(round, 20), (w) => w.enqueue(DEMO_IDS.alerts, alertsRound(rng)));
  }
  world.at(at(round, 60), questionCheck);
  world.at(at(round, 75), reviveCheck);
  scheduleNudges(world, round);
  world.at(at(round, 150), (w) => {
    if (w.status(DEMO_IDS.deps) === 'idle') w.enqueue(DEMO_IDS.deps, depsTurn(rng));
  });
  world.at(at(round, 200), answerCheck);
  world.at(at(round, 235), (w) => w.enqueue(L, wrapUp(round)));
  world.at(at(round + 1, 0), (w) => startRound(w, round + 1, seed));
}

/** Replies to messages the story did not script (the user's own). */
function createReplies(seed: number): DemoReplies {
  const rng = deriveRandom(seed, 'replies');
  const poolsOf = (spec: DemoSessionSpec): DemoPools =>
    Object.values(DEMO_CAST).find((member) => member.spec.id === spec.id)?.pools ??
    DEMO_CAST.lead.pools;
  return {
    reply(spec) {
      const p = poolsOf(spec);
      const file = rng.pick(p.files);
      const command = rng.pick(p.commands);
      return [
        say(rng.pick(['On it.', 'Sure, looking now.', 'Good idea. Checking.']), 1),
        read(file),
        bash(command, 3),
        say(
          rng.pick([
            `Done: ${file} is updated and ${command} passes.`,
            `Handled. ${rng.pick(p.notes)}`,
            `Folded that in and re-ran ${command}; all clean.`,
          ]),
        ),
        end,
      ];
    },
    revive(spec) {
      const p = poolsOf(spec);
      const command = rng.pick(p.commands);
      return [
        say('Picking up where it stopped.', 1),
        bash(command, 4),
        say(`Back on track: ${command} passes.`),
        end,
      ];
    },
    noted() {
      return rng.pick([
        "Noted. I'll fold that into this pass.",
        'Got it, adding that to what I am doing.',
        'Thanks, will do once this step finishes.',
      ]);
    },
    handoff(_spec, from) {
      const p = poolsOf(from);
      const file = rng.pick(p.files);
      const command = rng.pick(p.commands);
      return [
        say(`Picking up "${from.label}". Checking its recent commits and changes first.`, 1.2),
        bash('git log --oneline -10', 2),
        bash('git status --short', 1.5),
        read(file, 2.5),
        bash(command, 4),
        say(`Caught up: ${rng.pick(p.notes)} Continuing from there.`),
        end,
      ];
    },
  };
}

/** Synthetic history for a session that existed before the demo started:
 *  its task, then rounds of tool calls and notes, ending `endAt`. */
function createBackstory(seed: number): DemoStory['backstory'] {
  return (spec, endAt) => {
    const member = Object.values(DEMO_CAST).find((m) => m.spec.id === spec.id);
    if (!member) return [];
    const rng = deriveRandom(seed, `history:${spec.id}`);
    const p = member.pools;
    const target = Math.min(DEMO_BACKSTORY_MAX_ENTRIES, Math.round(spec.messageCount * 0.4));
    const entries: Array<Omit<StreamSessionDetail['entries'][number], 'at'>> = [];
    const key = (kind: string) => `demo-h-${spec.id.slice(-4)}-${kind}-${entries.length}`;
    entries.push(
      spec.leadId
        ? { role: 'peerIn', text: spec.prompt, peerSessionId: spec.leadId, key: key('peerIn') }
        : { role: 'user', text: spec.prompt, key: key('u') },
    );
    while (entries.length < target) {
      const tools = rng.int(2, 3);
      for (let i = 0; i < tools && entries.length < target; i++) {
        const kind = rng.pick(['Read', 'Read', 'Bash', 'Edit', 'Grep'] as const);
        const input =
          kind === 'Bash'
            ? { command: rng.pick(p.commands) }
            : kind === 'Grep'
              ? { pattern: rng.pick(p.patterns), path: 'src' }
              : { file_path: rng.pick(p.files) };
        entries.push({
          role: 'tool',
          text: formatConductorToolStatus(kind, input),
          toolName: kind,
          key: `tool:${key('t')}`,
        });
      }
      if (entries.length < target) {
        entries.push({ role: 'assistant', text: rng.pick(p.notes), key: key('a') });
      }
      if (entries.length < target && p.followUps.length > 0 && rng.next() < 0.18) {
        entries.push({ role: 'user', text: rng.pick(p.followUps), key: key('u') });
      }
    }
    const span = DEMO_BACKSTORY_SPAN_MIN * 60 * MS_PER_SEC;
    const step = span / Math.max(1, entries.length);
    const startAt = endAt - span;
    return entries.map((entry, i) => ({ ...entry, at: Math.round(startAt + i * step) }));
  };
}

export function createDemoStory(seed: number): DemoStory {
  return {
    specs: DEMO_SPECS,
    replies: createReplies(seed),
    backstory: createBackstory(seed),
    start(world) {
      world.begin();
      startRound(world, 0, seed);
    },
  };
}
