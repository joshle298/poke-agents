import { useEffect, useMemo, useState } from 'react';

import type {
  ConductorScope,
  ConductorSessionSummary,
  ConductorStatus,
} from '../../../core/src/messages.js';
import {
  requestConductorSessions,
  setConductorScope,
  setSessionHidden,
  setSessionPinned,
} from '../conductor/actions.js';
import { useConductor } from '../conductor/conductorStore.js';
import {
  agoText,
  CLOUD_ONLY_NOTE,
  conductorStatusLine,
  modelLabel,
  needsSignIn,
  NO_LIMIT_NOTE,
  windowOptions,
  workspaceLabel,
} from '../conductor/format.js';
import { useNow } from '../conductor/hooks.js';
import { groupSessions, leadSessionIds } from '../conductor/sessionsView.js';
import {
  CONDUCTOR_SCOPE_MAX_SESSIONS,
  CONDUCTOR_SCOPE_WINDOW_HOURS,
  CONDUCTOR_UI_TICK_MS,
} from '../constants.js';
import { ConductorConnectCard } from './ConductorConnectCard.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

interface SessionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** A read-only office can look but not change scope or visibility. */
  readOnly: boolean;
}

const STATUS_DOT: Record<ConductorSessionSummary['status'], string> = {
  working: 'bg-status-active',
  idle: 'bg-status-success',
  error: 'bg-status-error',
};

const STATUS_TEXT: Record<ConductorSessionSummary['status'], string> = {
  working: 'Working',
  idle: 'Idle',
  error: 'Error',
};

const IDLE_LABEL_ID = 'sessions-idle-limit';
/** What turning "Show idle sessions" off leaves (the server keeps pinned
 *  sessions and Leads with busy children too). */
const SHOW_IDLE_HINT = 'Off: only working, waiting and errored sessions';

function SegmentButtons<T extends string | number>({
  options,
  value,
  disabled,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return options.map((option) => (
    <Button
      key={String(option.value)}
      size="sm"
      variant={option.value === value ? 'active' : 'default'}
      aria-pressed={option.value === value}
      disabled={disabled}
      onClick={() => onChange(option.value)}
    >
      {option.label}
    </Button>
  ));
}

function Segmented<T extends string | number>({
  label,
  ...buttons
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  label: string;
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-4 flex-wrap">
      <span className="text-xs text-text-muted w-72 shrink-0">{label}</span>
      <SegmentButtons {...buttons} />
    </div>
  );
}

function ToggleBox({
  checked,
  label,
  hint,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  /** A muted second line, read as part of the toggle's name. */
  hint?: string;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      title={label}
      aria-pressed={checked}
      className="flex items-start gap-4 bg-transparent border-0 p-0 cursor-pointer text-xs text-left disabled:cursor-default"
    >
      <span
        className={`w-14 h-14 shrink-0 border-2 border-control-border inline-flex items-center justify-center text-2xs leading-none text-on-accent pb-2 ${
          checked ? 'bg-accent' : 'bg-transparent'
        }`}
      >
        {checked ? 'x' : ''}
      </span>
      <span className="flex flex-col gap-2">
        {label}
        {hint && <span className="text-2xs text-text-muted">{hint}</span>}
      </span>
    </button>
  );
}

function SessionRow({
  session,
  isLead,
  leadLabel,
  now,
  readOnly,
}: {
  session: ConductorSessionSummary;
  isLead: boolean;
  leadLabel: string | undefined;
  now: number;
  readOnly: boolean;
}) {
  const meta = [
    workspaceLabel(session.workspaceNumber, session.workspaceName),
    modelLabel(session.model, session.harness),
    session.creatorName,
    session.lastActivityAt ? agoText(session.lastActivityAt, now) : undefined,
  ].filter(Boolean);
  return (
    <li className="flex items-center gap-8 py-4 px-6 border-b border-border last:border-b-0">
      <span
        className={`size-6 shrink-0 ${STATUS_DOT[session.status]}`}
        title={STATUS_TEXT[session.status]}
      />
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div className="flex items-center gap-6 min-w-0">
          <span className={`text-sm truncate ${session.hidden ? 'text-text-muted' : ''}`}>
            {session.label}
          </span>
          {isLead && (
            <span className="text-2xs leading-none px-3 py-1 border border-accent text-accent shrink-0">
              LEAD
            </span>
          )}
          {session.agentId !== undefined && (
            <span className="text-2xs leading-none text-text-muted shrink-0">in office</span>
          )}
        </div>
        <span className="text-2xs text-text-muted truncate">
          {leadLabel ? `↳ ${leadLabel} · ` : ''}
          {meta.join(' · ')}
        </span>
      </div>
      <Button
        size="sm"
        variant={session.pinned ? 'active' : 'ghost'}
        disabled={readOnly}
        onClick={() => setSessionPinned(session.sessionId, !session.pinned)}
        title={session.pinned ? 'Pinned: always shown' : 'Pin: always show this session'}
      >
        <span
          className="material-symbols-sharp text-[18px]"
          aria-hidden="true"
          style={session.pinned ? undefined : { fontVariationSettings: "'FILL' 0" }}
        >
          push_pin
        </span>
      </Button>
      <ToggleBox
        checked={!session.hidden}
        label="Show"
        disabled={readOnly}
        onChange={() => setSessionHidden(session.sessionId, !session.hidden)}
      />
    </li>
  );
}

function EmptyState({
  status,
  hasSessions,
  query,
  readOnly,
}: {
  status: ConductorStatus | null;
  hasSessions: boolean;
  query: string;
  readOnly: boolean;
}) {
  if (needsSignIn(status)) {
    return (
      <div className="px-10 py-8 text-sm flex flex-col gap-6">
        <span>Connect to Conductor</span>
        <ConductorConnectCard readOnly={readOnly} />
      </div>
    );
  }
  if (hasSessions && query.trim()) {
    return <div className="px-10 py-8 text-sm">No sessions match “{query.trim()}”.</div>;
  }
  return (
    <div className="px-10 py-8 text-sm flex flex-col gap-4">
      <span>No sessions in scope.</span>
      <span className="text-xs text-text-muted">
        Hide fewer idle sessions, include everyone&apos;s workspaces, or show idle sessions.
      </span>
    </div>
  );
}

/**
 * Sessions: who is visible in the office. Scope (creator, "Hide sessions idle
 * longer than", idle sessions, cap), search across every in-scope session
 * (hidden ones included), and per-session Show and Pin, grouped by repository.
 */
export function SessionsModal({ isOpen, onClose, readOnly }: SessionsModalProps) {
  const status = useConductor((s) => s.status);
  const sessions = useConductor((s) => s.sessions);
  const now = useNow(CONDUCTOR_UI_TICK_MS, isOpen);
  const [query, setQuery] = useState('');
  // Optimistic scope: what the user last picked, until the server's
  // conductorStatus confirms (or corrects) it.
  const [draftScope, setDraftScope] = useState<ConductorScope | null>(null);
  const serverScope = status?.scope ?? null;
  useEffect(() => setDraftScope(null), [serverScope]);
  const scope = draftScope ?? serverScope;

  useEffect(() => {
    if (isOpen && !readOnly) requestConductorSessions();
  }, [isOpen, readOnly]);

  const groups = useMemo(() => groupSessions(sessions ?? [], query), [sessions, query]);
  const leads = useMemo(() => leadSessionIds(sessions ?? []), [sessions]);
  const labelById = useMemo(
    () => new Map((sessions ?? []).map((s) => [s.sessionId, s.label])),
    [sessions],
  );
  const hasSessions = (sessions ?? []).some((s) => !s.archived);

  const changeScope = (patch: Partial<ConductorScope>) => {
    if (!scope) return;
    const next = { ...scope, ...patch };
    setDraftScope(next);
    setConductorScope(next);
  };

  const activeWindowOptions = useMemo(
    () => windowOptions(CONDUCTOR_SCOPE_WINDOW_HOURS, scope?.activeWithinHours),
    [scope?.activeWithinHours],
  );
  const maxOptions = useMemo(() => {
    const values = new Set<number>(CONDUCTOR_SCOPE_MAX_SESSIONS);
    if (scope) values.add(scope.maxSessions);
    return [...values].sort((a, b) => a - b).map((value) => ({ value, label: String(value) }));
  }, [scope]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Sessions" className="w-[min(640px,100%)]">
      <div className="flex flex-col gap-8 px-10 pb-8">
        <div className="text-xs text-text-muted">{conductorStatusLine(status, now)}</div>

        {scope && (
          <div className="flex flex-col gap-6">
            <Segmented
              label="Whose"
              value={scope.creator}
              disabled={readOnly}
              options={[
                { value: 'me', label: 'Mine' },
                { value: 'all', label: 'Everyone' },
              ]}
              onChange={(creator) => changeScope({ creator })}
            />
            <div className="flex flex-col gap-4">
              <span id={IDLE_LABEL_ID} className="text-xs text-text-muted">
                Hide sessions idle longer than
              </span>
              <div
                className="flex items-center gap-4 flex-wrap pl-72 ml-4"
                role="group"
                aria-labelledby={IDLE_LABEL_ID}
              >
                <SegmentButtons
                  value={scope.activeWithinHours}
                  disabled={readOnly}
                  options={activeWindowOptions}
                  onChange={(activeWithinHours) => changeScope({ activeWithinHours })}
                />
              </div>
              {scope.activeWithinHours === 0 && (
                <span className="text-2xs text-text-muted pl-72 ml-4">{NO_LIMIT_NOTE}</span>
              )}
              <div className="pl-72 ml-4 pt-2">
                <ToggleBox
                  checked={scope.showIdle}
                  label="Show idle sessions"
                  hint={SHOW_IDLE_HINT}
                  disabled={readOnly}
                  onChange={() => changeScope({ showIdle: !scope.showIdle })}
                />
              </div>
            </div>
            <Segmented
              label="At most"
              value={scope.maxSessions}
              disabled={readOnly}
              options={maxOptions}
              onChange={(maxSessions) => changeScope({ maxSessions })}
            />
          </div>
        )}

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions, workspaces, repos…"
          className="w-full text-sm py-4 px-8 bg-btn-bg border-2 border-border rounded-none text-text"
        />

        {groups.length === 0 ? (
          <EmptyState status={status} hasSessions={hasSessions} query={query} readOnly={readOnly} />
        ) : (
          <div className="flex flex-col gap-8">
            {groups.map((group) => (
              <section key={group.repo} className="flex flex-col">
                <div className="flex items-baseline justify-between text-xs text-accent pb-2">
                  <span className="truncate">{group.repo || 'No repo'}</span>
                  <span className="text-text-muted shrink-0">{group.sessions.length}</span>
                </div>
                <ul className="m-0 p-0 list-none border-2 border-border">
                  {group.sessions.map((session) => (
                    <SessionRow
                      key={session.sessionId}
                      session={session}
                      isLead={leads.has(session.sessionId)}
                      leadLabel={
                        session.leadSessionId ? labelById.get(session.leadSessionId) : undefined
                      }
                      now={now}
                      readOnly={readOnly}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        <div className="text-xs leading-tight text-text-muted">{CLOUD_ONLY_NOTE}</div>
      </div>
    </Modal>
  );
}
