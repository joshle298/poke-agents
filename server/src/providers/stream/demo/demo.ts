/**
 * Demo provider (`poke-agents --demo`): a StreamProvider that plays a scripted
 * story of synthetic Conductor sessions instead of polling Conductor. Nothing
 * connects to Conductor and nothing is written to disk; sprites and cries
 * still come through the runtime's usual cache.
 *
 * It registers as the `conductor` provider, so the office shows its full
 * Conductor chrome (party bar, Pokédex with Chat, PC Box, Sessions modal),
 * and the user's actions act on the fake sessions.
 */

import type { ConductorScope, ConductorSessionSummary } from '../../../../../core/src/messages.js';
import type {
  AgentEventSink,
  ModelChoice,
  StreamModelCatalog,
  StreamProvider,
  StreamSessionDetail,
} from '../../../../../core/src/provider.js';
import { conductorContextWindow } from '../conductor/conductor.js';
import {
  CONDUCTOR_PERMISSION_EXEMPT_TOOLS,
  CONDUCTOR_READING_TOOLS,
  CONDUCTOR_SUBAGENT_TOOLS,
  formatConductorToolStatus,
} from '../conductor/tools.js';
import { buildModelCatalog, continuationName, parseModelChoice } from '../modelCatalog.js';
import {
  DEFAULT_DEMO_SEED,
  DEFAULT_DEMO_SPEED,
  DEMO_DISPLAY_NAME,
  DEMO_FAVORITE_MODELS,
  DEMO_LOG_PREFIX,
  DEMO_PROVIDER_ID,
  DEMO_SPEED_MAX,
  DEMO_SPEED_MIN,
  DEMO_TICK_MS,
  ENV_DEMO_SPEED,
} from './constants.js';
import { createDemoStory } from './story.js';
import { type DemoHarness, DemoWorld } from './world.js';

export interface DemoProviderOptions {
  /** Varies the generated history, replies and later rounds (round 0 is fixed). */
  seed?: number;
  /** Script speed factor (default 1, or POKE_AGENTS_DEMO_SPEED). */
  speed?: number;
  /** Injected for tests: environment for the speed override. */
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  /** Wall clock, for timestamps and the script position. */
  now?: () => number;
  /** False: nothing plays until advanceTo() (tests). */
  autoTick?: boolean;
}

type DemoControls = Required<
  Pick<
    StreamProvider,
    | 'contextWindowForModel'
    | 'onDismiss'
    | 'setSessionHidden'
    | 'setSessionPinned'
    | 'getScope'
    | 'setScope'
    | 'listSessions'
    | 'getSessionDetail'
    | 'getSessionHistory'
    | 'sendMessage'
    | 'stopSession'
    | 'archiveSession'
    | 'restoreSession'
    | 'setFocus'
    | 'getModelCatalog'
    | 'continueWithModel'
  >
>;

export type DemoProvider = StreamProvider &
  DemoControls & {
    readonly seed: number;
    readonly speed: number;
    /** Play the script up to `scriptMs` (tests; production ticks on a timer). */
    advanceTo(scriptMs: number): void;
  };

/** The speed factor: the option, else the environment, else 1; clamped. */
export function resolveDemoSpeed(speed: number | undefined, env: NodeJS.ProcessEnv): number {
  const fromEnv = Number(env[ENV_DEMO_SPEED]);
  const raw =
    typeof speed === 'number' && Number.isFinite(speed) && speed > 0
      ? speed
      : Number.isFinite(fromEnv) && fromEnv > 0
        ? fromEnv
        : DEFAULT_DEMO_SPEED;
  return Math.min(DEMO_SPEED_MAX, Math.max(DEMO_SPEED_MIN, raw));
}

export function createDemoProvider(opts: DemoProviderOptions = {}): DemoProvider {
  const seed = Number.isSafeInteger(opts.seed) ? (opts.seed as number) : DEFAULT_DEMO_SEED;
  const speed = resolveDemoSpeed(opts.speed, opts.env ?? process.env);
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? ((msg: string) => console.log(`${DEMO_LOG_PREFIX} ${msg}`));
  const story = createDemoStory(seed);

  let world: DemoWorld | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let startedAt = 0;
  let failed = false;

  const requireWorld = (): DemoWorld => {
    if (!world) throw new Error('The demo is not running.');
    return world;
  };

  /** A script bug must not take the office down: log it once and stop playing. */
  const advance = (scriptMs: number): void => {
    if (!world || failed) return;
    try {
      world.advance(scriptMs);
    } catch (err) {
      failed = true;
      log(`the script stopped: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    kind: 'stream',
    id: DEMO_PROVIDER_ID,
    displayName: DEMO_DISPLAY_NAME,
    protocolVersion: 1,
    seed,
    speed,

    formatToolStatus: formatConductorToolStatus,
    permissionExemptTools: CONDUCTOR_PERMISSION_EXEMPT_TOOLS,
    subagentToolNames: CONDUCTOR_SUBAGENT_TOOLS,
    readingTools: CONDUCTOR_READING_TOOLS,
    contextWindowForModel: conductorContextWindow,

    async start(sink: AgentEventSink): Promise<void> {
      if (world) return;
      world = new DemoWorld({
        sink,
        specs: story.specs,
        replies: story.replies,
        backstory: story.backstory,
        now,
      });
      startedAt = now();
      story.start(world);
      advance(0);
      if (opts.autoTick ?? true) {
        timer = setInterval(() => advance((now() - startedAt) * speed), DEMO_TICK_MS);
        timer.unref?.();
      }
      log(
        `playing synthetic sessions (seed ${seed}, speed ${speed}x). Nothing connects to Conductor.`,
      );
    },

    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = undefined;
    },

    advanceTo(scriptMs: number): void {
      advance(scriptMs);
    },

    onDismiss(sessionId: string): void {
      world?.setHidden(sessionId, true);
    },

    setSessionHidden(sessionId: string, hidden: boolean): void {
      requireWorld().setHidden(sessionId, hidden);
    },

    setSessionPinned(sessionId: string, pinned: boolean): void {
      requireWorld().setPinned(sessionId, pinned);
    },

    getScope(): ConductorScope {
      return requireWorld().getScope();
    },

    setScope(scope: ConductorScope): void {
      requireWorld().setScope(scope);
    },

    listSessions(): ConductorSessionSummary[] {
      return world ? world.listSessions() : [];
    },

    async getSessionDetail(sessionId: string): Promise<StreamSessionDetail | null> {
      return world ? world.getDetail(sessionId) : null;
    },

    async getSessionHistory(sessionId: string, before?: string) {
      return requireWorld().getHistory(sessionId, before);
    },

    async sendMessage(sessionId: string, text: string): Promise<void> {
      const message = text.trim();
      if (!message) throw new Error('Message is empty');
      requireWorld().sendMessage(sessionId, message);
    },

    async stopSession(sessionId: string): Promise<void> {
      requireWorld().stopSession(sessionId);
    },

    async archiveSession(sessionId: string): Promise<void> {
      requireWorld().archive(sessionId);
    },

    async restoreSession(sessionId: string): Promise<void> {
      requireWorld().restore(sessionId);
    },

    setFocus(): void {
      // Every demo session is always up to date.
    },

    async getModelCatalog(): Promise<StreamModelCatalog> {
      return buildModelCatalog({ favoriteModels: DEMO_FAVORITE_MODELS });
    },

    async continueWithModel(
      sessionId: string,
      request: ModelChoice,
    ): Promise<{ sessionId: string }> {
      const w = requireWorld();
      const parsed = parseModelChoice({ ...request }, buildModelCatalog(undefined));
      if (!parsed.ok) throw new Error(parsed.message);
      const choice = parsed.choice;
      const id = w.continueSession(sessionId, {
        agent: choice.agent as DemoHarness,
        model: choice.model,
        effort: choice.effort,
        fastMode: choice.fastMode,
        name: continuationName(w.labelOf(sessionId), choice.model),
        message: choice.message,
      });
      return { sessionId: id };
    },
  };
}
