import { Fragment, useEffect, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import {
  BUBBLE_FADE_DURATION_SEC,
  CONTEXT_CRITICAL_THRESHOLD,
  CONTEXT_DANGER_THRESHOLD,
  CONTEXT_GAUGE_BG,
  CONTEXT_GAUGE_COLOR_CRITICAL,
  CONTEXT_GAUGE_COLOR_DANGER,
  CONTEXT_GAUGE_COLOR_OK,
  CONTEXT_GAUGE_COLOR_WARN,
  CONTEXT_GAUGE_HEIGHT_PX,
  CONTEXT_GAUGE_WIDTH_PX,
  CONTEXT_WARN_THRESHOLD,
  HP_BAR_HEIGHT_PX,
  HP_BAR_WIDTH_PX,
  HP_BG,
  NOTICE_ERROR_COLOR,
  OVERLAY_BUBBLE_Z_INDEX,
  OVERLAY_LABEL_SELECTED_Z_INDEX,
  OVERLAY_LABEL_Z_INDEX,
  SPEECH_BUBBLE_MAX_WIDTH_PX,
  SPEECH_BUBBLE_PREVIEW_OFFSET_X_PX,
  SPEECH_BUBBLE_RISE_PX,
  STATUS_BADGE_COLORS,
  STATUS_BADGE_TEXT_COLOR,
  TOWN_COMPACT_LABEL_CHARS,
  TOWN_COMPACT_LABEL_MAX_SCALE,
  TOWN_FAINT_CHIP_LIFT_PX,
} from '../../constants.js';
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js';
import type { OfficeState } from '../engine/officeState.js';
import { isPokemonCharacter, overlayAnchorY } from '../engine/pokemonCharacter.js';
import type { OverlayProjection } from '../projection.js';
import { overlayProjection } from '../projection.js';
import { BUBBLE_ALERT_SPRITE, BUBBLE_SLEEP_SPRITE } from '../sprites/pokemonUiSprites.js';
import { getCachedSprite } from '../sprites/spriteCache.js';
import { BUBBLE_PERMISSION_SPRITE, BUBBLE_WAITING_SPRITE } from '../sprites/spriteData.js';
import type { Character, SpriteData, ToolActivity } from '../types.js';
import {
  CONDITION_BADGE,
  hpColor,
  hpFraction,
  isThemedOverlay,
  pokemonLabel,
  themedRoleLabel,
} from './pokemonOverlay.js';

// Both turn-end states show the green checkmark bubble. A finished turn (Stop)
// shows ONLY the checkmark (the label falls through to its normal idle text);
// going idle waiting on the user (Notification(idle_prompt)) additionally
// surfaces this label. Driven by Character.waitingAwaitingInput.
const WAITING_INPUT_ACTIVITY_TEXT = 'Waiting for input';

interface ToolOverlayProps {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: SubagentCharacter[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onCloseAgent: (id: number) => void;
  alwaysShowOverlay: boolean;
}

/** Derive a short human-readable activity string from tools/status */
function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
  bubbleType: 'permission' | 'waiting' | null,
  waitingAwaitingInput: boolean,
  errorMessage?: string,
): string {
  // Only stream sessions report errors; upstream agents never reach this.
  if (errorMessage !== undefined) return errorMessage || 'Error';
  if (bubbleType === 'permission') return 'Needs approval';
  // Only the idle case ("Waiting for input") gets a dedicated label. A finished
  // turn (Stop, waitingAwaitingInput=false) falls through so the checkmark alone
  // signals "done", same as the original behavior.
  if (bubbleType === 'waiting' && waitingAwaitingInput) return WAITING_INPUT_ACTIVITY_TEXT;

  const tools = agentTools[agentId];
  if (tools && tools.length > 0) {
    // Find the latest non-done tool
    const activeTool = [...tools].reverse().find((t) => !t.done);
    if (activeTool) {
      if (activeTool.permissionWait) return 'Needs approval';
      return activeTool.status;
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1];
      if (lastTool) return lastTool.status;
    }
  }

  return 'Idle';
}

function getFuelColor(ratio: number): string {
  if (ratio >= CONTEXT_CRITICAL_THRESHOLD) return CONTEXT_GAUGE_COLOR_CRITICAL;
  if (ratio >= CONTEXT_DANGER_THRESHOLD) return CONTEXT_GAUGE_COLOR_DANGER;
  if (ratio >= CONTEXT_WARN_THRESHOLD) return CONTEXT_GAUGE_COLOR_WARN;
  return CONTEXT_GAUGE_COLOR_OK;
}

/** A speech-bubble sprite blitted into a DOM canvas. Bubbles live in the DOM
 *  (not the office canvas) so they can stack ABOVE the status label panels —
 *  canvas content can never out-paint the DOM overlay. */
function OverlayBubble({ cached, dpr }: { cached: HTMLCanvasElement; dpr: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = cached.width;
    canvas.height = cached.height;
    canvas.getContext('2d')?.drawImage(cached, 0, 0);
  }, [cached]);
  return (
    <canvas
      ref={canvasRef}
      className="block"
      style={{ width: cached.width / dpr, height: cached.height / dpr }}
    />
  );
}

/** Which bubble a character shows, and its opacity. Upstream: permission dots,
 *  or the done checkmark fading out. Themed: a "!" while it needs you (until
 *  it turns active), the checkmark, or "z" while a drawn Pokémon sleeps. */
function bubbleFor(ch: Character, themed: boolean): { sprite: SpriteData; alpha: number } | null {
  const fade =
    ch.bubbleType === 'waiting' && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC
      ? ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC
      : 1;
  if (!themed) {
    if (!ch.bubbleType || (ch.bubbleType === 'waiting' && ch.waitingAwaitingInput)) return null;
    return {
      sprite: ch.bubbleType === 'permission' ? BUBBLE_PERMISSION_SPRITE : BUBBLE_WAITING_SPRITE,
      alpha: fade,
    };
  }
  const label = pokemonLabel(ch);
  if (label.condition === 'fainted') return null;
  if (label.condition === 'needsYou') return { sprite: BUBBLE_ALERT_SPRITE, alpha: 1 };
  if (ch.bubbleType === 'waiting' && !ch.waitingAwaitingInput) {
    return { sprite: BUBBLE_WAITING_SPRITE, alpha: fade };
  }
  if (label.condition === 'asleep' && isPokemonCharacter(ch)) {
    return { sprite: BUBBLE_SLEEP_SPRITE, alpha: 1 };
  }
  return null;
}

/** A fainted character resting in the town's Pokémon Center: a small FNT
 *  chip over its head, so it reads without hovering (theme on or off). */
function FaintChip({ left, top }: { left: number; top: number }) {
  return (
    <div
      className="absolute pointer-events-none leading-none px-2"
      style={{
        left,
        top,
        transform: 'translate(-50%, -100%)',
        fontSize: '14px',
        background: STATUS_BADGE_COLORS.fainted,
        color: STATUS_BADGE_TEXT_COLOR,
        zIndex: OVERLAY_LABEL_Z_INDEX,
      }}
    >
      {CONDITION_BADGE.fainted}
    </div>
  );
}

/** A nickname cut to `max` characters, with an ellipsis when cut. */
function shortName(name: string, max: number): string {
  return name.length > max ? `${name.slice(0, max - 1).trimEnd()}…` : name;
}

/** Always-shown labels in the town at low zoom: one line (status badge and a
 *  short nickname), so a busy Lab isn't buried under cards. Hover or select
 *  brings back the full card. */
function CompactLabel({
  ch,
  id,
  left,
  top,
}: {
  ch: Character;
  id: number;
  left: number;
  top: number;
}) {
  const label = pokemonLabel(ch);
  return (
    <div
      className="absolute flex items-center gap-3 px-4 pb-2 pixel-panel whitespace-nowrap leading-none pointer-events-none"
      style={{
        left,
        top,
        transform: 'translate(-50%, -100%)',
        fontSize: '14px',
        opacity: 0.85,
        zIndex: OVERLAY_LABEL_Z_INDEX,
      }}
      data-testid="agent-overlay"
      data-agent-id={id}
    >
      {label.condition && (
        <span
          className="shrink-0 px-2 leading-none"
          style={{
            fontSize: '12px',
            background: STATUS_BADGE_COLORS[label.condition],
            color: STATUS_BADGE_TEXT_COLOR,
          }}
        >
          {CONDITION_BADGE[label.condition]}
        </span>
      )}
      <span>{shortName(label.nickname ?? '', TOWN_COMPACT_LABEL_CHARS)}</span>
    </div>
  );
}

interface ThemedLabelProps {
  ch: Character;
  id: number;
  left: number;
  top: number;
  isSelected: boolean;
  dimmed: boolean;
  dotColor: string | null;
  pulse: boolean;
  activityText: string;
  showHp: boolean;
  contextRatio: number;
  onClose: () => void;
}

/** The themed label: nickname + Lv and a status badge, the activity, the
 *  species and directory in small text, and an HP bar (context left) in place
 *  of the gauge. Hangs from its anchor by its bottom edge, so extra lines grow
 *  upward instead of over the character. */
function ThemedLabel({
  ch,
  id,
  left,
  top,
  isSelected,
  dimmed,
  dotColor,
  pulse,
  activityText,
  showHp,
  contextRatio,
  onClose,
}: ThemedLabelProps) {
  const label = pokemonLabel(ch);
  const roleLabel = themedRoleLabel(ch, label.nickname);
  const hp = hpFraction(ch.contextTokens, ch.maxContextTokens);
  return (
    <div
      className="absolute flex flex-col items-center"
      style={{
        left,
        top,
        transform: 'translate(-50%, -100%)',
        pointerEvents: isSelected ? 'auto' : 'none',
        opacity: dimmed ? 0.75 : 1,
        zIndex: isSelected ? OVERLAY_LABEL_SELECTED_Z_INDEX : OVERLAY_LABEL_Z_INDEX,
      }}
      data-testid="agent-overlay"
      data-agent-id={id}
    >
      <div className="flex items-center border-border px-8 pt-2 pb-4 gap-5 pixel-panel whitespace-nowrap max-w-2xs">
        {dotColor && (
          <span
            className={`w-6 h-6 rounded-full shrink-0 ${pulse ? 'pixel-pulse' : ''}`}
            style={{ background: dotColor }}
          />
        )}
        <div className="flex flex-col gap-0 overflow-hidden">
          {roleLabel && (
            <span
              className={`overflow-hidden text-ellipsis block leading-none ${
                ch.isTeamLead ? 'text-team-lead font-bold' : 'text-team-role'
              }`}
              style={{ fontSize: '18px' }}
            >
              {roleLabel}
            </span>
          )}
          {(label.nickname || label.level || label.condition) && (
            <span className="flex items-center gap-4 leading-none" style={{ fontSize: '22px' }}>
              {label.nickname && (
                <span className="overflow-hidden text-ellipsis">{label.nickname}</span>
              )}
              {label.level && <span className="shrink-0">{label.level}</span>}
              {label.condition && (
                <span
                  className="shrink-0 px-2 leading-none"
                  style={{
                    fontSize: '14px',
                    background: STATUS_BADGE_COLORS[label.condition],
                    color: STATUS_BADGE_TEXT_COLOR,
                  }}
                >
                  {CONDITION_BADGE[label.condition]}
                </span>
              )}
            </span>
          )}
          <span
            className="overflow-hidden text-ellipsis block leading-none"
            style={{ fontSize: '20px' }}
          >
            {activityText}
          </span>
          {(label.species || ch.directoryName) && (
            <span className="text-2xs leading-none overflow-hidden text-ellipsis block">
              {[label.species, ch.directoryName].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
        {isSelected && (
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            title="Close agent"
            className="ml-2 shrink-0 leading-none"
          >
            ×
          </Button>
        )}
      </div>
      {showHp && (
        <div className="flex items-center gap-2 leading-none" style={{ marginTop: 2 }}>
          <span className="text-2xs leading-none">HP</span>
          <div
            style={{ width: HP_BAR_WIDTH_PX, height: HP_BAR_HEIGHT_PX, background: HP_BG }}
            title={`${Math.round(hp * 100)}% context left (${(ch.contextTokens / 1000).toFixed(0)}k of ${(ch.maxContextTokens / 1000).toFixed(0)}k tokens used)`}
            data-testid="context-gauge"
            data-context-pct={Math.round(contextRatio * 100)}
          >
            <div style={{ width: `${hp * 100}%`, height: '100%', background: hpColor(hp) }} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Message previews near their receivers and agent notices above heads: DOM
 *  speech bubbles that follow the characters (projected every frame), lifted
 *  clear of the sprite bubble ("!", checkmark) a character may be showing. */
function SpeechBubbles({
  officeState,
  project,
  zoom,
  dpr,
}: {
  officeState: OfficeState;
  project: OverlayProjection;
  zoom: number;
  dpr: number;
}) {
  const fadeOf = (timer: number) =>
    timer < BUBBLE_FADE_DURATION_SEC ? timer / BUBBLE_FADE_DURATION_SEC : 1;
  const lift = (BUBBLE_ALERT_SPRITE.length * zoom) / dpr + SPEECH_BUBBLE_RISE_PX;
  const bubbleStyle = (left: number, top: number, timer: number, centered: boolean) => ({
    left,
    top,
    maxWidth: SPEECH_BUBBLE_MAX_WIDTH_PX,
    transform: centered ? 'translate(-50%, -100%)' : 'translateY(-100%)',
    opacity: fadeOf(timer),
    zIndex: OVERLAY_BUBBLE_Z_INDEX,
  });
  return (
    <>
      {officeState.messagePreviews.map((m) => {
        const ch = officeState.characters.get(m.toId);
        if (!ch) return null;
        return (
          <div
            key={`preview-${m.id}`}
            className="absolute pixel-panel px-6 py-2 text-2xs leading-tight whitespace-normal break-words pointer-events-none"
            style={bubbleStyle(
              project.toScreenX(ch.x) + SPEECH_BUBBLE_PREVIEW_OFFSET_X_PX,
              project.toScreenY(overlayAnchorY(ch, 'bubble')) - lift,
              m.timer,
              false,
            )}
          >
            {m.text}
          </div>
        );
      })}
      {Array.from(officeState.notices, ([id, notice]) => {
        const ch = officeState.characters.get(id);
        if (!ch) return null;
        return (
          <div
            key={`notice-${id}`}
            className="absolute pixel-panel px-6 py-2 text-2xs leading-tight whitespace-normal break-words pointer-events-none"
            style={{
              ...bubbleStyle(
                project.toScreenX(ch.x),
                project.toScreenY(overlayAnchorY(ch, 'bubble')) - lift,
                notice.timer,
                true,
              ),
              color: notice.tone === 'error' ? NOTICE_ERROR_COLOR : undefined,
            }}
          >
            {notice.text}
          </div>
        );
      })}
    </>
  );
}

export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  subagentTools,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
  alwaysShowOverlay,
}: ToolOverlayProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  if (!el) return null;
  // dpr is also needed to size the bubble canvases in CSS px (OverlayBubble).
  const dpr = window.devicePixelRatio || 1;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    dpr,
  );

  const selectedId = officeState.selectedAgentId;
  const hoveredId = officeState.hoveredAgentId;

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)];

  return (
    <>
      <SpeechBubbles officeState={officeState} project={project} zoom={zoom} dpr={dpr} />
      {allIds.map((id) => {
        const ch = officeState.characters.get(id);
        if (!ch) return null;

        const isSelected = selectedId === id;
        const isHovered = hoveredId === id;
        const isSub = ch.isSubagent;

        // Speech bubble (permission dots / done checkmark) — rendered here in
        // the DOM, above the label panels (OVERLAY_BUBBLE_Z_INDEX over the label panels), for every
        // character regardless of label visibility. Mirrors the geometry the
        // canvas renderer used. The idle "Waiting for input" state speaks
        // through its label, not a bubble — except when themed, where needing
        // you (permission or a question) is a "!" until the agent turns active.
        const themed = isThemedOverlay(ch);
        const bubble = bubbleFor(ch, themed);
        let bubbleNode = null;
        if (bubble) {
          const cachedBubble = getCachedSprite(bubble.sprite, zoom);
          bubbleNode = (
            <div
              className="absolute -translate-x-1/2 pointer-events-none"
              style={{
                left: project.toScreenX(ch.x),
                // Bubble bottom sits one sprite pixel above the character's
                // anchor: project the anchor, then lift by the bubble's own
                // device-pixel height plus one zoomed pixel, in CSS px.
                top:
                  project.toScreenY(overlayAnchorY(ch, 'bubble')) -
                  (cachedBubble.height + zoom) / dpr,
                opacity: bubble.alpha,
                zIndex: OVERLAY_BUBBLE_Z_INDEX,
              }}
            >
              <OverlayBubble cached={cachedBubble} dpr={dpr} />
            </div>
          );
        }

        // Only show the label for hovered or selected agents (unless
        // always-show is on) — the bubble renders regardless. A fainted
        // character resting in the town shows a FNT chip instead.
        if (!alwaysShowOverlay && !isSelected && !isHovered) {
          const faintChip =
            ch.isErrored && ch.townGoal === 'center' ? (
              <FaintChip
                left={project.toScreenX(ch.x)}
                top={project.toScreenY(overlayAnchorY(ch, 'bubble')) - TOWN_FAINT_CHIP_LIFT_PX}
              />
            ) : null;
          if (!bubbleNode && !faintChip) return null;
          return (
            <Fragment key={id}>
              {bubbleNode}
              {faintChip}
            </Fragment>
          );
        }

        // Position above character
        const screenX = project.toScreenX(ch.x);
        const screenY = project.toScreenY(overlayAnchorY(ch, 'label'));

        // A "Done" agent (finished turn: waiting bubble without awaitingInput)
        // shows ONLY its floating green checkmark bubble, never the label panel
        // (the panel would cover the bubble). Render an empty positioned marker
        // so overlay counts stay stable and hover/select can still bring the
        // panel back. When always-show is off, the early return above already
        // keeps the panel hidden for idle agents.
        const isDone = ch.bubbleType === 'waiting' && !ch.waitingAwaitingInput;
        if (isDone && !isSelected && !isHovered) {
          return (
            <Fragment key={id}>
              {bubbleNode}
              <div
                className="absolute"
                style={{ left: screenX, top: screenY, pointerEvents: 'none' }}
                data-testid="agent-overlay"
                data-agent-id={id}
              />
            </Fragment>
          );
        }

        // In the town at low zoom, always-shown labels shrink to one line.
        if (
          themed &&
          !isSelected &&
          !isHovered &&
          officeState.town !== null &&
          zoom / dpr <= TOWN_COMPACT_LABEL_MAX_SCALE
        ) {
          return (
            <Fragment key={id}>
              {bubbleNode}
              <CompactLabel ch={ch} id={id} left={screenX} top={screenY} />
            </Fragment>
          );
        }

        // Get activity text
        const hasWaitingBubble = ch.bubbleType === 'waiting';
        const subHasPermission = isSub && ch.bubbleType === 'permission';
        let activityText: string;
        if ((hasWaitingBubble && ch.waitingAwaitingInput) || (themed && ch.awaitingInput)) {
          // Idle, waiting on the user -> dedicated label. A finished turn (Stop)
          // shows only the checkmark and falls through to the normal idle text.
          // Themed, the question holds the label until the agent turns active.
          activityText = WAITING_INPUT_ACTIVITY_TEXT;
        } else if (isSub) {
          if (subHasPermission) {
            activityText = 'Needs approval';
          } else {
            // Hover shows the subtask title; SELECTING the sub reveals its live
            // tool activity (watched sub-agents stream it via subagentToolStart).
            const sub = subagentCharacters.find((s) => s.id === id);
            const rows = sub ? subagentTools[sub.parentAgentId]?.[sub.parentToolId] : undefined;
            const activeRow =
              isSelected && rows ? [...rows].reverse().find((t) => !t.done) : undefined;
            activityText = activeRow?.status ?? (sub?.label || 'Subtask');
          }
        } else {
          activityText = getActivityText(
            id,
            agentTools,
            ch.isActive,
            ch.bubbleType,
            ch.waitingAwaitingInput ?? false,
            ch.isErrored ? (ch.errorMessage ?? '') : undefined,
          );
        }

        // Determine dot color
        const tools = agentTools[id];
        const hasPermission = subHasPermission || tools?.some((t) => t.permissionWait && !t.done);
        const hasActiveTools = tools?.some((t) => !t.done);
        const isActive = ch.isActive;
        const hasWaiting = ch.bubbleType === 'waiting';

        let dotColor: string | null = null;
        if (hasPermission || hasWaiting) {
          dotColor = 'var(--color-status-permission)';
        } else if (isActive && hasActiveTools) {
          dotColor = 'var(--color-status-active)';
        }

        // Team info
        const teamRoleLabel = ch.isTeamLead ? 'LEAD' : ch.agentName || null;
        const hasExtraLines = !!(ch.directoryName || teamRoleLabel);

        // Context gauge. Every agent gets one — lead, teammate, adopted,
        // headless — as soon as it has taken a turn. Sub-agents never do: they
        // have no session of their own, so contextTokens stays 0.
        const contextRatio = ch.contextTokens / ch.maxContextTokens;
        const showContextGauge = !isSub && ch.contextTokens > 0;

        if (themed) {
          return (
            <Fragment key={id}>
              {bubbleNode}
              <ThemedLabel
                ch={ch}
                id={id}
                left={screenX}
                top={screenY}
                isSelected={isSelected}
                dimmed={alwaysShowOverlay && !isSelected && !isHovered}
                dotColor={dotColor}
                pulse={isActive && !hasPermission && !hasWaiting}
                activityText={activityText}
                showHp={showContextGauge}
                contextRatio={contextRatio}
                onClose={() => onCloseAgent(id)}
              />
            </Fragment>
          );
        }

        return (
          <Fragment key={id}>
            {bubbleNode}
            <div
              className="absolute flex flex-col items-center -translate-x-1/2"
              style={{
                left: screenX,
                top: screenY - (hasExtraLines ? 34 : 28),
                pointerEvents: isSelected ? 'auto' : 'none',
                opacity: alwaysShowOverlay && !isSelected && !isHovered ? (isSub ? 0.5 : 0.75) : 1,
                zIndex: isSelected ? OVERLAY_LABEL_SELECTED_Z_INDEX : OVERLAY_LABEL_Z_INDEX,
              }}
              data-testid="agent-overlay"
              data-agent-id={id}
            >
              <div className="flex items-center border-border px-8 pt-2 pb-4 gap-5 pixel-panel whitespace-nowrap max-w-2xs">
                {dotColor && (
                  <span
                    className={`w-6 h-6 rounded-full shrink-0 ${isActive && !hasPermission && !hasWaiting ? 'pixel-pulse' : ''}`}
                    style={{ background: dotColor }}
                  />
                )}
                <div className="flex flex-col gap-0 overflow-hidden">
                  {teamRoleLabel && (
                    <span
                      className={`overflow-hidden text-ellipsis block leading-none ${
                        ch.isTeamLead ? 'text-team-lead font-bold' : 'text-team-role'
                      }`}
                      style={{ fontSize: '18px' }}
                    >
                      {teamRoleLabel}
                    </span>
                  )}
                  <span
                    className="overflow-hidden text-ellipsis block leading-none"
                    style={{
                      fontSize: isSub ? '20px' : '22px',
                      fontStyle: isSub ? 'italic' : undefined,
                    }}
                  >
                    {activityText}
                  </span>
                  {ch.directoryName && (
                    <span className="text-2xs leading-none overflow-hidden text-ellipsis block">
                      {ch.directoryName}
                    </span>
                  )}
                </div>
                {isSelected && !isSub && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseAgent(id);
                    }}
                    title="Close agent"
                    className="ml-2 shrink-0 leading-none"
                  >
                    ×
                  </Button>
                )}
              </div>
              {showContextGauge && (
                <div
                  style={{
                    width: CONTEXT_GAUGE_WIDTH_PX,
                    height: CONTEXT_GAUGE_HEIGHT_PX,
                    background: CONTEXT_GAUGE_BG,
                    marginTop: 2,
                  }}
                  title={`${Math.round(contextRatio * 100)}% context used (${(ch.contextTokens / 1000).toFixed(0)}k of ${(ch.maxContextTokens / 1000).toFixed(0)}k tokens)`}
                  data-testid="context-gauge"
                  data-context-pct={Math.round(contextRatio * 100)}
                >
                  <div
                    style={{
                      width: `${Math.min(contextRatio * 100, 100)}%`,
                      height: '100%',
                      background: getFuelColor(contextRatio),
                    }}
                  />
                </div>
              )}
            </div>
          </Fragment>
        );
      })}
    </>
  );
}
