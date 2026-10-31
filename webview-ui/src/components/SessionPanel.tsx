import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';

import type { SessionDetail, SessionDetailEntry } from '../../../core/src/messages.js';
import {
  archiveSession,
  openInConductor,
  requestConductorSessions,
  requestModelCatalog,
  reviveSession,
  sendSessionMessage,
  setSessionHidden,
  setSessionPinned,
  stopSession,
} from '../conductor/actions.js';
import { questionTitle, sendState, toolLabel } from '../conductor/chat.js';
import { plainText } from '../conductor/chatText.js';
import type { ConductorAgent } from '../conductor/conductorStore.js';
import {
  currentActivity,
  findSpecies,
  isStreamProvider,
  useConductor,
} from '../conductor/conductorStore.js';
import { agoText, isConductorDeepLink, shortAge, workspaceLabel } from '../conductor/format.js';
import { useSleepClock } from '../conductor/hooks.js';
import { sessionModelRows } from '../conductor/modelPicker.js';
import type { PartyCondition } from '../conductor/party.js';
import {
  agentCondition,
  conditionBadge,
  hpFraction,
  pickPortrait,
  portraitEmotion,
} from '../conductor/party.js';
import {
  CONDUCTOR_UI_TICK_MS,
  POKEDEX_ACTION_RESULT_VISIBLE_MS,
  POKEDEX_CHAT_PORTRAIT_PX,
  POKEDEX_DRAWER_Z_INDEX,
  POKEDEX_PANEL_WIDTH_PX,
  POKEDEX_PORTRAIT_PX,
  POKEDEX_SEND_TIMEOUT_MS,
  POKEDEX_SHEET_MAX_HEIGHT_RATIO,
  POKEDEX_SHEET_Z_INDEX,
} from '../constants.js';
import { useEscapeLayer } from '../hooks/useEscapeLayer.js';
import { usePokedexRefresh } from '../hooks/usePokedexRefresh.js';
import { usePokemonOffice } from '../hooks/usePokemonOffice.js';
import type { AgentAppearance } from './AgentCard.js';
import { CharacterMugShot } from './CharacterMugShot.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { HpBar } from './HpBar.js';
import { ModelPickerModal } from './ModelPickerModal.js';
import { PokedexChat } from './PokedexChat.js';
import { PokemonPickerModal } from './PokemonPickerModal.js';
import { CapsuleIcon, PokemonPortrait } from './PokemonPortrait.js';
import { ReplyBox } from './ReplyBox.js';
import { Button } from './ui/Button.js';
import { tabButtonId, tabPanelId } from './ui/tabKeys.js';
import { TabList } from './ui/TabList.js';

/** docked = flex sibling of the office (wide windows); drawer = over the
 *  office's right edge (narrow windows); sheet = mobile bottom sheet. */
export type SessionPanelMode = 'docked' | 'drawer' | 'sheet';

/** Overview = the session's facts, actions and recent lines; Chat = the
 *  conversation with its reply box. */
export type PokedexTab = 'overview' | 'chat';

interface SessionPanelProps {
  agentId: number;
  mode: SessionPanelMode;
  /** Drawer only: room kept clear on the right for the party bar. */
  rightInsetPx?: number;
  readOnly: boolean;
  appearance: AgentAppearance;
  /** Kept by the App, so switching agents keeps the open tab. */
  tab: PokedexTab;
  onTabChange: (tab: PokedexTab) => void;
  /** Whether an agent id has a character in the office (peer jumps). */
  isInOffice: (agentId: number) => boolean;
  /** Select a peer in the office and show its Pokédex. */
  onJump: (agentId: number) => void;
  onClose: () => void;
}

const CONDITION_TEXT: Record<PartyCondition, string> = {
  working: 'Working',
  needsYou: 'Needs you',
  done: 'Done',
  asleep: 'Asleep',
  error: 'Fainted',
};

const ROLE_LABEL: Record<Exclude<SessionDetailEntry['role'], 'tool'>, string> = {
  user: 'You',
  assistant: 'Said',
  peerIn: 'From',
  peerOut: 'To',
};

/** Line height for wrapped prose (the pixel font's default leading is loose). */
const TEXT_LINE_HEIGHT = 1.3;

const STOP_CONFIRM_TEXT = 'Stops the current turn. Messages still queued in Conductor are dropped.';
const DEPOSIT_CONFIRM_TEXT =
  'Archives this session in Conductor. Withdraw it from the PC Box to bring it back.';

const TABS: ReadonlyArray<{ id: PokedexTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'chat', label: 'Chat' },
];
const TABS_ID = 'pokedex';

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex gap-8 min-w-0">
      <span className="w-84 shrink-0 text-text-muted">{label}</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  );
}

function statusTextFor(agent: ConductorAgent | undefined, condition: PartyCondition | null) {
  if (!condition) return null;
  if (condition === 'needsYou') {
    return agent?.permission ? 'Needs your permission' : 'Waiting for your answer';
  }
  return CONDITION_TEXT[condition];
}

/** What the Recent list says about its lines: loading, empty, or the lines. */
function RecentList({
  detail,
  readOnly,
  now,
  isInOffice,
  onJump,
}: {
  detail: SessionDetail | undefined;
  readOnly: boolean;
  now: number;
  isInOffice: (agentId: number) => boolean;
  onJump: (agentId: number) => void;
}) {
  const entries = useMemo(() => [...(detail?.entries ?? [])].reverse(), [detail]);
  if (readOnly) {
    return (
      <span className="text-xs text-text-muted">
        View-only offices can&apos;t load the conversation.
      </span>
    );
  }
  if (!detail) return <span className="text-xs text-text-muted">Loading…</span>;
  if (entries.length === 0) return <span className="text-xs text-text-muted">Nothing yet.</span>;
  return (
    <ul className="m-0 p-0 list-none flex flex-col gap-6">
      {entries.map((entry, i) => {
        const peer = entry.peerId !== undefined && isInOffice(entry.peerId) ? entry.peerId : null;
        const peerName = entry.peerLabel ?? (peer !== null ? `Agent ${peer}` : '');
        return (
          <li key={`${entry.key ?? entry.at}:${i}`} className="text-xs flex flex-col gap-2">
            <span className="text-text-muted">
              {entry.role === 'tool' ? toolLabel(entry) : ROLE_LABEL[entry.role]}
              {(entry.role === 'peerIn' || entry.role === 'peerOut') && peerName && (
                <>
                  {' '}
                  {peer !== null ? (
                    <button
                      className="bg-transparent border-0 p-0 cursor-pointer underline text-accent"
                      onClick={() => onJump(peer)}
                      title="Show this session"
                    >
                      {peerName}
                    </button>
                  ) : (
                    peerName
                  )}
                </>
              )}
              {' · '}
              {shortAge(entry.at, now)}
            </span>
            <span
              className="whitespace-pre-wrap break-words"
              style={{ lineHeight: TEXT_LINE_HEIGHT }}
            >
              {plainText(entry.text)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The Pokédex: one stream (Conductor) agent's facts, conversation and
 * actions, in two tabs (Overview, Chat). Requests sessionDetail on open and
 * every POKEDEX_REFRESH_MS while open and visible; older conversation pages
 * only when the chat asks; everything else arrives through the store.
 */
export function SessionPanel({
  agentId,
  mode,
  rightInsetPx = 0,
  readOnly,
  appearance,
  tab,
  onTabChange,
  isInOffice,
  onJump,
  onClose,
}: SessionPanelProps) {
  const agent = useConductor((s) => s.agents[agentId]);
  const detail = useConductor((s) => s.sessionDetails[agentId]);
  const history = useConductor((s) => s.chatHistories[agentId]);
  const speciesMap = useConductor((s) => s.species);
  const sessions = useConductor((s) => s.sessions);
  const outcome = useConductor((s) => s.actionOutcomes[agentId]);
  const modelCatalog = useConductor((s) => s.modelCatalog);
  const pokemonTheme = useConductor((s) => s.pokemonTheme);
  const now = useSleepClock(CONDUCTOR_UI_TICK_MS, true, agentId);
  const pokemonOffice = usePokemonOffice();

  const [draft, setDraft] = useState('');
  const [confirm, setConfirm] = useState<'stop' | 'deposit' | null>(null);
  const [picker, setPicker] = useState<'model' | 'pokemon' | null>(null);
  // The message last sent from here, until its conductorActionResult.
  const [sent, setSent] = useState<{ at: number; text: string } | null>(null);

  // A read-only office would only have the request refused.
  usePokedexRefresh(agentId, !readOnly);

  // Pin state lives in the session list; fetch it once if we never have.
  const needSessions = sessions === null && !readOnly;
  useEffect(() => {
    if (needSessions) requestConductorSessions();
  }, [needSessions]);

  // Escape closes the panel when it is the topmost surface: an open modal or
  // confirmation above it takes the key first, and Escape typed in the
  // reply box keeps the draft (escapeStack.ts).
  useEscapeLayer(true, onClose, { z: POKEDEX_DRAWER_Z_INDEX, closeFromFields: false });

  const species = findSpecies({ species: speciesMap }, agent?.species, agent?.shiny);
  const condition = agentCondition(agent, now);
  const badge = conditionBadge(condition);
  const hp = hpFraction(agent);
  const activity = currentActivity(agent);
  const sessionId = agent?.conductorSessionId;
  const summary = useMemo(
    () => (sessionId ? sessions?.find((s) => s.sessionId === sessionId) : undefined),
    [sessions, sessionId],
  );
  const pinned = summary?.pinned === true;
  const canAct = !readOnly && isStreamProvider(agent?.providerId);
  const canOpen = !readOnly && isConductorDeepLink(agent?.externalUrl);
  const isRunning = agent?.status === 'active' || agent?.permission === true;
  const statusText = statusTextFor(agent, condition);
  const nickname = agent?.label ?? `Agent ${agentId}`;
  const portraitUrl = pickPortrait(species?.portraits, portraitEmotion(condition));
  const question = detail?.question;
  const modelRows = sessionModelRows(agent, modelCatalog);
  const canChangePokemon = canAct && pokemonTheme && agent?.species !== undefined;
  // The Overview names the model with the catalog's labels: fetch it once
  // (the server caches it; the picker asks again for fresh favorites).
  const needModelCatalog = canAct && modelCatalog === null;
  useEffect(() => {
    if (needModelCatalog) requestModelCatalog();
  }, [needModelCatalog]);
  // The picker's own outcomes report inside it.
  const pickerAction =
    outcome?.action === 'continueWithModel' || outcome?.action === 'setAgentPokemon';

  // The reply box's state: a send waits for its conductorActionResult; the
  // outcome line fades after POKEDEX_ACTION_RESULT_VISIBLE_MS.
  const rawSendState = sendState(sent?.at ?? null, outcome, now, POKEDEX_SEND_TIMEOUT_MS);
  const answersSend = outcome !== undefined && sent !== null && outcome.at >= sent.at;
  const settledAt =
    rawSendState === 'unconfirmed'
      ? (sent?.at ?? 0) + POKEDEX_SEND_TIMEOUT_MS
      : answersSend
        ? outcome.at
        : 0;
  const replyState =
    rawSendState !== 'sending' && now - settledAt >= POKEDEX_ACTION_RESULT_VISIBLE_MS
      ? 'idle'
      : rawSendState;
  // Refused: put the text back, unless something new was typed meanwhile.
  const failedText = rawSendState === 'failed' ? sent?.text : undefined;
  useEffect(() => {
    if (failedText !== undefined) setDraft((d) => (d.trim() ? d : failedText));
  }, [failedText]);
  // Other actions (Stop, Revive, Pin…) report under the action buttons; a
  // message sent from the reply box reports beside it.
  const showOutcome =
    outcome &&
    !(outcome.action === 'sendSessionMessage' && answersSend) &&
    !pickerAction &&
    now - outcome.at < POKEDEX_ACTION_RESULT_VISIBLE_MS;

  const sendText = (text: string) => {
    const message = text.trim();
    if (!message || rawSendState === 'sending') return;
    setSent({ at: Date.now(), text: message });
    sendSessionMessage(agentId, message);
  };
  const sendDraft = () => {
    if (!draft.trim() || rawSendState === 'sending') return;
    sendText(draft);
    setDraft('');
  };

  const replyBox = (
    <ReplyBox
      draft={draft}
      onDraftChange={setDraft}
      onSend={sendDraft}
      state={replyState}
      errorMessage={outcome?.action === 'sendSessionMessage' ? outcome.message : undefined}
      rows={tab === 'chat' && mode !== 'sheet' ? 3 : 2}
      enterSends={mode !== 'sheet'}
    />
  );

  const fallbackPortrait = (size: number) =>
    pokemonOffice ? (
      <CapsuleIcon size={size} />
    ) : (
      <CharacterMugShot palette={appearance.palette} hueShift={appearance.hueShift} size={size} />
    );
  const speciesLine = [
    species
      ? `${species.name}${agent?.shiny ? ' (shiny)' : ''}`
      : agent?.species !== undefined
        ? `No. ${agent.species}`
        : null,
    agent?.level !== undefined ? `Lv ${agent.level}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const frame: Record<SessionPanelMode, string> = {
    docked: 'relative h-full shrink-0 border-l-2',
    drawer: 'absolute top-0 bottom-0 border-l-2 shadow-pixel',
    // Absolute in the App root, not fixed: on iOS the root shrinks to the
    // visible viewport while the keyboard is up, so the reply box stays in
    // view.
    sheet: 'absolute left-0 right-0 bottom-0 border-t-2 shadow-pixel',
  };
  const sheetHeight = `${POKEDEX_SHEET_MAX_HEIGHT_RATIO * 100}%`;
  const frameStyle: Record<SessionPanelMode, CSSProperties> = {
    docked: { width: POKEDEX_PANEL_WIDTH_PX },
    drawer: {
      right: rightInsetPx,
      width: `min(${POKEDEX_PANEL_WIDTH_PX}px, calc(100% - ${rightInsetPx}px))`,
      zIndex: POKEDEX_DRAWER_Z_INDEX,
    },
    // The chat fills the sheet (its thread scrolls); the overview sizes to fit.
    sheet:
      tab === 'chat'
        ? { height: sheetHeight, zIndex: POKEDEX_SHEET_Z_INDEX }
        : { maxHeight: sheetHeight, zIndex: POKEDEX_SHEET_Z_INDEX },
  };

  return (
    <aside
      className={`flex flex-col min-h-0 bg-bg border-border text-sm ${frame[mode]}`}
      style={frameStyle[mode]}
      aria-label="Pokédex"
    >
      <div className="flex items-center justify-between shrink-0 px-8 py-4 bg-accent text-on-accent">
        <span className="text-base leading-none">Pokédex</span>
        <Button
          variant="ghost"
          size="icon"
          className="text-on-accent! hover:text-on-accent!"
          onClick={onClose}
          title="Close"
        >
          ×
        </Button>
      </div>

      <TabList
        label="Pokédex view"
        idPrefix={TABS_ID}
        className="shrink-0 px-8 pt-6"
        tabs={TABS.map(({ id, label }) => ({
          id,
          label: (
            <>
              {label}
              {id === 'chat' && question ? <span className="text-accent"> !</span> : null}
            </>
          ),
        }))}
        selected={tab}
        onSelect={onTabChange}
      />

      {tab === 'chat' ? (
        <div
          role="tabpanel"
          id={tabPanelId(TABS_ID)}
          aria-labelledby={tabButtonId(TABS_ID, tab)}
          className="flex-1 min-h-0 flex flex-col"
        >
          <div className="flex items-center gap-6 shrink-0 px-8 pt-6">
            <PokemonPortrait
              url={portraitUrl}
              size={POKEDEX_CHAT_PORTRAIT_PX}
              alt={species?.name ?? ''}
              fallback={fallbackPortrait(POKEDEX_CHAT_PORTRAIT_PX)}
            />
            <div className="flex-1 min-w-0 flex flex-col gap-2">
              <span className="text-sm leading-none truncate" title={nickname}>
                {nickname}
              </span>
              <span className="text-2xs leading-none text-text-muted truncate">
                {[speciesLine, statusText].filter(Boolean).join(' · ')}
              </span>
            </div>
            {badge && <span className="text-sm text-accent">{badge}</span>}
          </div>
          <PokedexChat
            agentId={agentId}
            agentName={species?.name ?? nickname}
            detail={detail}
            history={history}
            now={now}
            canAct={canAct}
            sending={rawSendState === 'sending'}
            onReply={sendText}
            replyBox={replyBox}
            sentAt={sent?.at}
            isInOffice={isInOffice}
            onJump={onJump}
          />
        </div>
      ) : (
        <div
          role="tabpanel"
          id={tabPanelId(TABS_ID)}
          aria-labelledby={tabButtonId(TABS_ID, tab)}
          className="flex-1 min-h-0 overflow-y-auto pixel-scrollbar px-8 py-8 flex flex-col gap-10"
        >
          {/* Header: portrait, nickname, species, level, condition */}
          <div className="pixel-dialog flex items-center gap-8 p-6">
            <PokemonPortrait
              url={portraitUrl}
              size={POKEDEX_PORTRAIT_PX}
              alt={species?.name ?? ''}
              fallback={fallbackPortrait(POKEDEX_PORTRAIT_PX)}
            />
            <div className="flex-1 min-w-0 flex flex-col gap-4">
              <span className="text-lg leading-none break-words">{nickname}</span>
              <span className="text-xs leading-none text-text-muted">{speciesLine}</span>
              {hp !== null && <HpBar fraction={hp} widthPx={120} heightPx={4} />}
              {canChangePokemon && (
                <Button
                  size="sm"
                  className="self-start"
                  onClick={() => setPicker('pokemon')}
                  title="Choose which Pokémon this session is"
                >
                  Change Pokémon…
                </Button>
              )}
            </div>
            {badge && <span className="self-start text-sm text-accent">{badge}</span>}
          </div>

          {question && (
            <div className="flex items-center gap-6 border-2 border-accent px-6 py-4 text-xs">
              <span className="flex-1 min-w-0 truncate" title={plainText(question.text)}>
                <span className="text-accent">{questionTitle(question.kind)}: </span>
                {plainText(question.text)}
              </span>
              <Button size="sm" className="shrink-0" onClick={() => onTabChange('chat')}>
                Answer in Chat
              </Button>
            </div>
          )}

          {/* Facts */}
          <div className="flex flex-col gap-4 text-xs">
            <InfoRow
              label="Workspace"
              value={workspaceLabel(agent?.workspaceNumber, agent?.workspaceName)}
            />
            <InfoRow label="Repo" value={agent?.repo} />
            <InfoRow label="Agent" value={modelRows.agent} />
            <InfoRow label="Model" value={modelRows.model} />
            <InfoRow label="Effort" value={modelRows.effort} />
            <InfoRow label="Status" value={statusText} />
            <InfoRow label="Doing" value={activity} />
            <InfoRow
              label="HP"
              value={
                hp !== null && agent?.contextTokens !== undefined
                  ? `${Math.round(hp * 100)}% context left`
                  : null
              }
            />
            <InfoRow label="By" value={agent?.creatorName} />
            <InfoRow
              label="Active"
              value={agent?.lastActivityAt ? agoText(agent.lastActivityAt, now) : null}
            />
          </div>

          {agent?.status === 'error' && agent.errorMessage && (
            <div className="border-2 border-status-error px-6 py-4 text-xs break-words">
              {agent.errorMessage}
            </div>
          )}
          {agent?.notice && (
            <div
              className={`border-2 px-6 py-4 text-xs break-words ${
                agent.notice.tone === 'error' ? 'border-status-error' : 'border-border'
              }`}
            >
              {agent.notice.text}
              <span className="text-text-muted"> · {agoText(agent.notice.at, now)}</span>
            </div>
          )}

          {/* Actions */}
          {(canAct || canOpen) && (
            <div className="flex flex-wrap gap-4">
              {canOpen && (
                <Button
                  size="sm"
                  variant="accent"
                  onClick={() => openInConductor(agent?.externalUrl)}
                  title="Open this session in the Conductor app"
                >
                  Open in Conductor
                </Button>
              )}
              {canAct && sessionId && (
                <Button
                  size="sm"
                  onClick={() => setPicker('model')}
                  title="Continue this work in a new session with another model"
                >
                  Switch model…
                </Button>
              )}
              {canAct && agent?.status === 'error' && (
                <Button
                  size="sm"
                  onClick={() => reviveSession(agentId)}
                  title="Send “continue” to the session"
                >
                  Revive
                </Button>
              )}
              {canAct && isRunning && (
                <Button size="sm" onClick={() => setConfirm('stop')}>
                  Stop
                </Button>
              )}
              {canAct && sessionId && (
                <>
                  <Button
                    size="sm"
                    onClick={() => setSessionPinned(sessionId, !pinned)}
                    title={pinned ? 'Stop always showing this session' : 'Always show this session'}
                  >
                    {pinned ? 'Unpin' : 'Pin'}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => setSessionHidden(sessionId, true)}
                    title="Hide from the office (show it again from Sessions)"
                  >
                    Hide
                  </Button>
                  <Button size="sm" onClick={() => setConfirm('deposit')}>
                    Deposit in PC
                  </Button>
                </>
              )}
            </div>
          )}
          {showOutcome && (
            <div className={`text-xs ${outcome.ok ? 'text-text-muted' : 'text-status-error'}`}>
              {outcome.ok ? 'Done.' : (outcome.message ?? 'Conductor refused the request.')}
            </div>
          )}

          {canAct && replyBox}

          {detail?.prompt && (
            <section className="flex flex-col gap-4">
              <span className="text-xs text-accent">Task</span>
              <p
                className="m-0 text-xs whitespace-pre-wrap break-words max-h-[140px] overflow-y-auto pixel-scrollbar"
                style={{ lineHeight: TEXT_LINE_HEIGHT }}
              >
                {plainText(detail.prompt)}
              </p>
            </section>
          )}

          <section className="flex flex-col gap-4">
            <span className="text-xs text-accent">Recent</span>
            <RecentList
              detail={detail}
              readOnly={readOnly}
              now={now}
              isInOffice={isInOffice}
              onJump={onJump}
            />
            {detail?.truncated && (
              <span className="text-2xs text-text-muted">Older entries are in Chat.</span>
            )}
          </section>
        </div>
      )}

      {picker === 'model' && (
        <ModelPickerModal
          agentId={agentId}
          agent={agent}
          onStop={canAct && isRunning ? () => setConfirm('stop') : undefined}
          onClose={() => setPicker(null)}
        />
      )}
      {picker === 'pokemon' && (
        <PokemonPickerModal agentId={agentId} agent={agent} onClose={() => setPicker(null)} />
      )}
      <ConfirmDialog
        isOpen={confirm === 'stop'}
        title="Stop session?"
        body={STOP_CONFIRM_TEXT}
        confirmLabel="Stop"
        onConfirm={() => stopSession(agentId)}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        isOpen={confirm === 'deposit'}
        title="Deposit in PC?"
        body={DEPOSIT_CONFIRM_TEXT}
        confirmLabel="Deposit"
        onConfirm={() => {
          if (sessionId) archiveSession(sessionId);
        }}
        onCancel={() => setConfirm(null)}
      />
    </aside>
  );
}
