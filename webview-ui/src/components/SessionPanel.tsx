import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';

import type { SessionDetailEntry } from '../../../core/src/messages.js';
import {
  archiveSession,
  openInConductor,
  requestConductorSessions,
  requestSessionDetail,
  reviveSession,
  sendSessionMessage,
  setSessionHidden,
  setSessionPinned,
  stopSession,
} from '../conductor/actions.js';
import {
  currentActivity,
  findSpecies,
  isStreamProvider,
  useConductor,
} from '../conductor/conductorStore.js';
import {
  agoText,
  isConductorDeepLink,
  modelLabel,
  shortAge,
  workspaceLabel,
} from '../conductor/format.js';
import { useNow } from '../conductor/hooks.js';
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
  POKEDEX_DRAWER_Z_INDEX,
  POKEDEX_PANEL_WIDTH_PX,
  POKEDEX_PORTRAIT_PX,
  POKEDEX_REFRESH_MS,
  POKEDEX_SHEET_MAX_HEIGHT_RATIO,
  POKEDEX_SHEET_Z_INDEX,
} from '../constants.js';
import type { AgentAppearance } from './AgentCard.js';
import { CharacterMugShot } from './CharacterMugShot.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { HpBar } from './HpBar.js';
import { PokemonPortrait } from './PokemonPortrait.js';
import { Button } from './ui/Button.js';

/** docked = flex sibling of the office (wide windows); drawer = over the
 *  office's right edge (narrow windows); sheet = mobile bottom sheet. */
export type SessionPanelMode = 'docked' | 'drawer' | 'sheet';

interface SessionPanelProps {
  agentId: number;
  mode: SessionPanelMode;
  /** Drawer only: room kept clear on the right for the party bar. */
  rightInsetPx?: number;
  readOnly: boolean;
  appearance: AgentAppearance;
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

const ROLE_LABEL: Record<SessionDetailEntry['role'], string> = {
  user: 'You',
  assistant: 'Said',
  tool: 'Used',
  peerIn: 'From',
  peerOut: 'To',
};

/** Line height for wrapped prose (the pixel font's default leading is loose). */
const TEXT_LINE_HEIGHT = 1.3;

const STOP_CONFIRM_TEXT = 'Stops the current turn. Messages still queued in Conductor are dropped.';
const DEPOSIT_CONFIRM_TEXT =
  'Archives this session in Conductor. Withdraw it from the PC Box to bring it back.';

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex gap-8 min-w-0">
      <span className="w-84 shrink-0 text-text-muted">{label}</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  );
}

/**
 * The Pokédex: one stream (Conductor) agent's facts, recent conversation and
 * actions. Requests sessionDetail on open and every POKEDEX_REFRESH_MS while
 * open; everything else arrives through the store.
 */
export function SessionPanel({
  agentId,
  mode,
  rightInsetPx = 0,
  readOnly,
  appearance,
  isInOffice,
  onJump,
  onClose,
}: SessionPanelProps) {
  const agent = useConductor((s) => s.agents[agentId]);
  const detail = useConductor((s) => s.sessionDetails[agentId]);
  const speciesMap = useConductor((s) => s.species);
  const sessions = useConductor((s) => s.sessions);
  const outcome = useConductor((s) => s.actionOutcomes[agentId]);
  const now = useNow(CONDUCTOR_UI_TICK_MS);

  const [draft, setDraft] = useState('');
  const [confirm, setConfirm] = useState<'stop' | 'deposit' | null>(null);

  // Detail on open and every few seconds while open. A read-only office
  // would only have the request refused.
  useEffect(() => {
    if (readOnly) return;
    requestSessionDetail(agentId);
    const timer = setInterval(() => requestSessionDetail(agentId), POKEDEX_REFRESH_MS);
    return () => clearInterval(timer);
  }, [agentId, readOnly]);

  // Pin state lives in the session list; fetch it once if we never have.
  const needSessions = sessions === null && !readOnly;
  useEffect(() => {
    if (needSessions) requestConductorSessions();
  }, [needSessions]);

  // Escape closes the panel unless the user is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
  const entries = useMemo(() => [...(detail?.entries ?? [])].reverse(), [detail]);
  const canAct = !readOnly && isStreamProvider(agent?.providerId);
  const canOpen = !readOnly && isConductorDeepLink(agent?.externalUrl);
  const isRunning = agent?.status === 'active' || agent?.permission === true;
  const showOutcome = outcome && now - outcome.at < POKEDEX_ACTION_RESULT_VISIBLE_MS;

  const statusText = (() => {
    if (!condition) return null;
    if (condition === 'needsYou') {
      return agent?.permission ? 'Needs your permission' : 'Waiting for your answer';
    }
    return CONDITION_TEXT[condition];
  })();

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    sendSessionMessage(agentId, text);
    setDraft('');
  };

  const frame: Record<SessionPanelMode, string> = {
    docked: 'relative h-full shrink-0 border-l-2',
    drawer: 'absolute top-0 bottom-0 border-l-2 shadow-pixel',
    sheet: 'fixed left-0 right-0 bottom-0 border-t-2 shadow-pixel',
  };
  const frameStyle: Record<SessionPanelMode, CSSProperties> = {
    docked: { width: POKEDEX_PANEL_WIDTH_PX },
    drawer: {
      right: rightInsetPx,
      width: `min(${POKEDEX_PANEL_WIDTH_PX}px, calc(100% - ${rightInsetPx}px))`,
      zIndex: POKEDEX_DRAWER_Z_INDEX,
    },
    sheet: {
      maxHeight: `${POKEDEX_SHEET_MAX_HEIGHT_RATIO * 100}%`,
      zIndex: POKEDEX_SHEET_Z_INDEX,
    },
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

      <div className="flex-1 min-h-0 overflow-y-auto pixel-scrollbar px-8 py-8 flex flex-col gap-10">
        {/* Header: portrait, nickname, species, level, condition */}
        <div className="pixel-dialog flex items-center gap-8 p-6">
          <PokemonPortrait
            url={pickPortrait(species?.portraits, portraitEmotion(condition))}
            size={POKEDEX_PORTRAIT_PX}
            alt={species?.name ?? ''}
            fallback={
              <CharacterMugShot
                palette={appearance.palette}
                hueShift={appearance.hueShift}
                size={POKEDEX_PORTRAIT_PX}
              />
            }
          />
          <div className="flex-1 min-w-0 flex flex-col gap-4">
            <span className="text-lg leading-none break-words">
              {agent?.label ?? `Agent ${agentId}`}
            </span>
            <span className="text-xs leading-none text-text-muted">
              {[
                species
                  ? `${species.name}${agent?.shiny ? ' (shiny)' : ''}`
                  : agent?.species !== undefined
                    ? `No. ${agent.species}`
                    : null,
                agent?.level !== undefined ? `Lv ${agent.level}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            {hp !== null && <HpBar fraction={hp} widthPx={120} heightPx={4} />}
          </div>
          {badge && <span className="self-start text-sm text-accent">{badge}</span>}
        </div>

        {/* Facts */}
        <div className="flex flex-col gap-4 text-xs">
          <InfoRow
            label="Workspace"
            value={workspaceLabel(agent?.workspaceNumber, agent?.workspaceName)}
          />
          <InfoRow label="Repo" value={agent?.repo} />
          <InfoRow label="Model" value={modelLabel(agent?.model, agent?.harness)} />
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

        {canAct && (
          <div className="flex flex-col gap-4">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder="Message this session…"
              className="w-full resize-none text-xs py-4 px-6 bg-btn-bg border-2 border-border rounded-none text-text"
            />
            <div className="flex justify-end">
              <Button size="sm" variant={draft.trim() ? 'default' : 'disabled'} onClick={send}>
                Send
              </Button>
            </div>
          </div>
        )}

        {detail?.prompt && (
          <section className="flex flex-col gap-4">
            <span className="text-xs text-accent">Task</span>
            <p
              className="m-0 text-xs whitespace-pre-wrap break-words max-h-[140px] overflow-y-auto pixel-scrollbar"
              style={{ lineHeight: TEXT_LINE_HEIGHT }}
            >
              {detail.prompt}
            </p>
          </section>
        )}

        <section className="flex flex-col gap-4">
          <span className="text-xs text-accent">Recent</span>
          {entries.length === 0 ? (
            <span className="text-xs text-text-muted">Nothing yet.</span>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col gap-6">
              {entries.map((entry, i) => {
                const peer =
                  entry.peerId !== undefined && isInOffice(entry.peerId) ? entry.peerId : null;
                const peerName = entry.peerLabel ?? (peer !== null ? `Agent ${peer}` : '');
                return (
                  <li key={`${entry.at}:${i}`} className="text-xs flex flex-col gap-2">
                    <span className="text-text-muted">
                      {ROLE_LABEL[entry.role]}
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
                      {entry.text}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {detail?.truncated && (
            <span className="text-2xs text-text-muted">Older entries not shown.</span>
          )}
        </section>
      </div>

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
