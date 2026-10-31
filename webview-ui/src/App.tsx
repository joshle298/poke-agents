import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { toMajorMinor } from './changelogData.js';
import type { SelectMods, TabStatus } from './components/AgentCard.js';
import type { CardBarLayout } from './components/AgentCardBar.js';
import { AgentCardBar } from './components/AgentCardBar.js';
import { BattleLog } from './components/BattleLog.js';
import { BottomToolbar } from './components/BottomToolbar.js';
import { ChangelogModal } from './components/ChangelogModal.js';
import { ConductorEmptyOffice } from './components/ConductorEmptyOffice.js';
import { ConnectionIndicator } from './components/ConnectionIndicator.js';
import { CreditsModal } from './components/CreditsModal.js';
import { DebugView } from './components/DebugView.js';
import { DirectoryModal } from './components/DirectoryModal.js';
import { EditActionBar } from './components/EditActionBar.js';
import { IntroBubble } from './components/IntroBubble.js';
import { MigrationNotice } from './components/MigrationNotice.js';
import { PcBoxModal } from './components/PcBoxModal.js';
import { SessionPanel } from './components/SessionPanel.js';
import { SessionsModal } from './components/SessionsModal.js';
import { SettingsModal } from './components/SettingsModal.js';
import { TerminalDrawer } from './components/TerminalDrawer.js';
import { Toasts } from './components/Toasts.js';
import { Tooltip } from './components/Tooltip.js';
import { Button } from './components/ui/Button.js';
import { Modal } from './components/ui/Modal.js';
import { VersionIndicator } from './components/VersionIndicator.js';
import { ZoomControls } from './components/ZoomControls.js';
import { openInConductor, setPokemonTheme } from './conductor/actions.js';
import type { ConductorAgent } from './conductor/conductorStore.js';
import { conductorStore, isStreamProvider, useConductor } from './conductor/conductorStore.js';
import { useWindowWidth } from './conductor/hooks.js';
import { buildPartySlot, partyOrder } from './conductor/party.js';
import { useBoolPref } from './conductor/preferences.js';
import { useConductorFeed } from './conductor/useConductorFeed.js';
import {
  BATTLE_LOG_BOTTOM_MOBILE_PX,
  BATTLE_LOG_BOTTOM_PX,
  BATTLE_LOG_STORAGE_KEY,
  OFFICE_CANVAS_TEST_ID,
  PARTY_WIDE_MIN_WINDOW_PX,
  POKEMON_THEME_NAME,
  TERMINAL_SIDEBAR_WIDTH_PX,
} from './constants.js';
import { useDirectoryEditor } from './hooks/useDirectoryEditor.js';
import { useEditorActions } from './hooks/useEditorActions.js';
import { useEditorKeyboard } from './hooks/useEditorKeyboard.js';
import type { Directory } from './hooks/useExtensionMessages.js';
import { useExtensionMessages } from './hooks/useExtensionMessages.js';
import { useIntroTour } from './hooks/useIntroTour.js';
import { useIsMobile } from './hooks/useIsMobile.js';
import { useKeyboardViewport } from './hooks/useKeyboardViewport.js';
import { useTerminalDrawer } from './hooks/useTerminalDrawer.js';
import { MobileShell } from './mobile/MobileShell.js';
import { useMobileShell } from './mobile/useMobileShell.js';
import { OfficeCanvas } from './office/components/OfficeCanvas.js';
import { ToolOverlay } from './office/components/ToolOverlay.js';
import { EditorState } from './office/editor/editorState.js';
import { EditorToolbar } from './office/editor/EditorToolbar.js';
import { OfficeState } from './office/engine/officeState.js';
import { exportLayoutToFile } from './office/layout/exportLayout.js';
import { isRotatable } from './office/layout/furnitureCatalog.js';
import { migrateLayoutColors } from './office/layout/layoutSerializer.js';
import { overlayProjection } from './office/projection.js';
import {
  getShowConnections,
  setShowConnections,
  subscribeShowConnections,
} from './office/showConnections.js';
import { getPetCount } from './office/sprites/petSpriteData.js';
import { EditTool, type OfficeLayout, TILE_SIZE } from './office/types.js';
import { isBrowserRuntime, isE2E } from './runtime.js';
import { installTestHooks } from './testHooks.js';
import { transport } from './transport/index.js';

// Game state lives outside React — updated imperatively by message handlers
const officeStateRef = { current: null as OfficeState | null };
const editorState = new EditorState();

// Test-only observability hooks (message/sound logs, addAgent wrapper, selectAgent).
// Installed only under the e2e harness so they never patch prototypes or grow
// unbounded logs in a real user's session.
if (isE2E) installTestHooks(officeStateRef);

function getOfficeState(): OfficeState {
  if (!officeStateRef.current) {
    officeStateRef.current = new OfficeState();
  }
  return officeStateRef.current;
}

/** A stream-provider (Conductor) agent: its character and card open the
 *  Pokédex instead of focusing a terminal. */
function isStreamAgent(agent: ConductorAgent | undefined): agent is ConductorAgent {
  return agent !== undefined && isStreamProvider(agent.providerId);
}

function App() {
  // Conductor chrome store. Registered before useExtensionMessages (effects
  // run in call order), so it is listening before webviewReady goes out.
  useConductorFeed();

  // Browser runtime (dev or static dist): dispatch mock messages after the
  // useExtensionMessages listener has been registered.
  useEffect(() => {
    // browserMock is for Vite dev mode only (UI prototyping without a server).
    // In standalone server mode, the server sends all state over WebSocket.
    // In VS Code mode, the extension sends all state via postMessage.
    if (isBrowserRuntime && import.meta.env.DEV) {
      void import('./browserMock.js').then(({ dispatchMockMessages }) => dispatchMockMessages());
    }
  }, []);

  const editor = useEditorActions(getOfficeState, editorState);

  const isEditDirty = useCallback(
    () => editor.isEditMode && editor.isDirty,
    [editor.isEditMode, editor.isDirty],
  );

  const {
    agents,
    selectedAgent,
    agentTools,
    agentStatuses,
    agentAwaitingInput,
    agentSeenActivity,
    subagentTools,
    subagentCharacters,
    layoutReady,
    layoutWasReset,
    loadedAssets,
    directories,
    directoryRejection,
    directorySaved,
    directorySuggestions,
    agentDirectoryNames,
    externalAssetDirectories,
    lastSeenVersion,
    extensionVersion,
    watchAllSessions,
    setWatchAllSessions,
    alwaysShowLabels,
    ghostHeadlessAgents,
    setGhostHeadlessAgents,
    hooksEnabled,
    hooksInstalled,
    hooksStatusSeq,
    hooksInfoShown,
    consentRequest,
    dismissConsentRequest,
    areaMappings,
    setAreaMappings,
    showAreas,
    setShowAreas,
    bypassPermissions,
    setBypassPermissions,
    showHostDirectories,
    setShowHostDirectories,
    officeReadOnly,
    terminalAvailable,
    terminalUnavailableReason,
    terminalAgentIds,
    setPokemonTheme: applyOfficePokemonTheme,
  } = useExtensionMessages(getOfficeState, editor.setLastSavedLayout, isEditDirty);

  // Show migration notice once layout reset is detected
  const [migrationNoticeDismissed, setMigrationNoticeDismissed] = useState(false);
  const showMigrationNotice = layoutWasReset && !migrationNoticeDismissed;

  const [isChangelogOpen, setIsChangelogOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHooksInfoOpen, setIsHooksInfoOpen] = useState(false);
  const [hooksTooltipDismissed, setHooksTooltipDismissed] = useState(false);
  const [isDebugMode, setIsDebugMode] = useState(false);
  const [alwaysShowOverlay, setAlwaysShowOverlay] = useState(false);

  // ── Conductor chrome ────────────────────────────────────────
  // Which providers feed the office decides the chrome: Claude Code brings
  // + Agent, hooks and Directories; Conductor brings Sessions and the PC Box.
  const activeProviders = useConductor((s) => s.activeProviders);
  const claudeActive = activeProviders.includes('claude');
  const conductorActive = activeProviders.includes('conductor');
  const conductorAgents = useConductor((s) => s.agents);
  const speciesMap = useConductor((s) => s.species);
  const pokemonTheme = useConductor((s) => s.pokemonTheme);
  const [isSessionsOpen, setIsSessionsOpen] = useState(false);
  const [isPcBoxOpen, setIsPcBoxOpen] = useState(false);
  const [isCreditsOpen, setIsCreditsOpen] = useState(false);
  // The agent whose Pokédex is open (stream agents only).
  const [detailAgentId, setDetailAgentId] = useState<number | null>(null);
  const [battleLogOn, setBattleLogOn] = useBoolPref(BATTLE_LOG_STORAGE_KEY, true);
  // Per-device (localStorage), owned by the office: its link layer reads the
  // same module state every frame.
  const showConnections = useSyncExternalStore(subscribeShowConnections, getShowConnections);
  const windowWidth = useWindowWidth();
  const wideWindow = windowWidth >= PARTY_WIDE_MIN_WINDOW_PX;

  // The theme is the server's setting (settingsLoaded / pokemonThemeUpdated),
  // applied as <html data-theme>, which swaps the index.css palette.
  // The office's render flag (Poké Balls, sprites, themed labels) follows the
  // same value, including the Settings toggle's optimistic change.
  useEffect(() => {
    const root = document.documentElement;
    if (pokemonTheme) root.dataset.theme = POKEMON_THEME_NAME;
    else delete root.dataset.theme;
    applyOfficePokemonTheme(pokemonTheme);
  }, [pokemonTheme, applyOfficePokemonTheme]);

  // Mobile shell (phones, touch tablets): office and terminal as sliding
  // full-screen pages with the cards in a bottom bar. Desktop keeps the
  // right-docked drawer.
  const isMobile = useIsMobile();
  // Software keyboard: whether it is up (the key bar shows), and the height
  // to clamp the shell to so the terminal shrinks (and the PTY resizes)
  // instead of hiding its input line under the keys (iOS only — Android
  // resizes the layout viewport itself).
  const keyboard = useKeyboardViewport(isMobile);
  // The office's imperative character selection, mirrored into React so the
  // card bars can restyle the focused agent's card on canvas taps.
  const focusedAgentId = useSyncExternalStore(
    useCallback((onChange: () => void) => getOfficeState().subscribeSelection(onChange), []),
    () => getOfficeState().selectedAgentId,
  );

  // Standalone only: every input here stays false/empty under VS Code. Owns the
  // active tab on both shells; the desktop-only bits (isOpen, width, resize)
  // are simply unread on mobile, where the sliding track plays the drawer.
  const terminalDrawer = useTerminalDrawer({
    terminalAgentIds,
    getOfficeState,
    agentTools,
    agentStatuses,
    agentAwaitingInput,
    agentSeenActivity,
  });

  const launchIntoDirectory = useCallback((directory: Directory) => {
    transport.send({ type: 'launchAgent', directoryPath: directory.path });
  }, []);
  const mobileShell = useMobileShell({
    getOfficeState,
    terminalAgentIds,
    drawer: terminalDrawer,
    focusedAgentId,
    launchAgent: launchIntoDirectory,
  });

  const currentMajorMinor = toMajorMinor(extensionVersion);

  const handleWhatsNewDismiss = useCallback(() => {
    transport.send({ type: 'setLastSeenVersion', version: currentMajorMinor });
  }, [currentMajorMinor]);

  const handleOpenChangelog = useCallback(() => {
    setIsChangelogOpen(true);
    transport.send({ type: 'setLastSeenVersion', version: currentMajorMinor });
  }, [currentMajorMinor]);

  // Sync alwaysShowOverlay from persisted settings
  useEffect(() => {
    setAlwaysShowOverlay(alwaysShowLabels);
  }, [alwaysShowLabels]);

  const directoryEditor = useDirectoryEditor({
    directories,
    directoryRejection,
    directorySaved,
    areaMappings,
    setAreaMappings,
    getOfficeState,
  });

  const handleToggleDebugMode = useCallback(() => setIsDebugMode((prev) => !prev), []);
  const handleToggleAlwaysShowOverlay = useCallback(() => {
    setAlwaysShowOverlay((prev) => {
      const newVal = !prev;
      transport.send({ type: 'setAlwaysShowLabels', enabled: newVal });
      return newVal;
    });
  }, []);

  // Toggle "Display headless as ghosts". setGhostHeadlessAgents also updates the
  // renderer's module copy, so the office redraws on the next frame.
  const handleToggleGhostHeadlessAgents = useCallback(() => {
    const next = !ghostHeadlessAgents;
    setGhostHeadlessAgents(next);
    transport.send({ type: 'setGhostHeadlessAgents', enabled: next });
  }, [ghostHeadlessAgents, setGhostHeadlessAgents]);

  const handleSelectAgent = useCallback((id: number) => {
    transport.send({ type: 'focusAgent', id });
  }, []);

  // The Intro's wire-facing state machine — which asks survive being mooted,
  // when a hooksStatus is this tour's install verdict — lives in useIntroTour
  // (pure reducer in introTourState.ts); the App only wires it to the bubble.
  const {
    intro,
    installFailed,
    installPending,
    onChoice: handleConsentChoice,
    onClose: handleIntroClose,
  } = useIntroTour({ consentRequest, hooksInstalled, hooksStatusSeq, dismissConsentRequest });

  // The Settings surface renders one provider today; its checkbox binds to
  // the Claude row of the per-provider install-state map.
  const claudeHooksInstalled = hooksInstalled['claude'] === true;

  // Mutate Directory→Area mappings locally + send to server. Updates OfficeState in
  // the same tick so a follow-up agentCreated picks up the new mapping.
  const handleAreaMappingChange = useCallback(
    (directoryName: string, areaLabel: string, action: 'add' | 'remove') => {
      const current = areaMappings[directoryName] ?? [];
      let nextLabels: string[];
      if (action === 'add') {
        if (current.includes(areaLabel)) return;
        nextLabels = [...current, areaLabel];
      } else {
        nextLabels = current.filter((l) => l !== areaLabel);
      }
      const next = { ...areaMappings };
      if (nextLabels.length === 0) {
        delete next[directoryName];
      } else {
        next[directoryName] = nextLabels;
      }
      setAreaMappings(next);
      getOfficeState().setAreaMappings(next);
      transport.send({ type: 'saveAreaMappings', mappings: next });
    },
    [areaMappings, setAreaMappings],
  );

  // Toggle global Show Areas — persisted via setShowAreas message; runs server-
  // side through configPersistence.
  const onToggleShowAreas = useCallback(() => {
    const next = !showAreas;
    setShowAreas(next);
    transport.send({ type: 'setShowAreas', enabled: next });
  }, [showAreas, setShowAreas]);

  // When AREA_PAINT is active in the editor, force the overlay on even if the
  // user has toggled Show Areas off globally — they need to see what they're
  // editing. The selected area's overlay is alpha-bumped via activeAreaLabel.
  const isEditingAreas = editor.isEditMode && editorState.activeTool === EditTool.AREA_PAINT;
  const effectiveShowAreas = isEditingAreas || showAreas;
  const activeAreaLabel = isEditingAreas ? editor.selectedAreaLabel : null;

  // e2e: register the component-scoped editor-action drivers + the effective
  // show-areas gate on the test-hooks namespace (module-load installTestHooks
  // can't reach these React callbacks). The action drivers bypass canvas
  // pixel→tile geometry — the handlers still own undo/dirty/rebuild; for specs
  // that drive the real canvas gesture instead, getTileCenter projects a tile
  // to canvas CSS pixels with the renderer's own zoom + pan. Guarded on isE2E.
  useEffect(() => {
    if (!isE2E || typeof window === 'undefined') return;
    const hooks = (window.__pixelAgentsTestHooks ??= {});
    hooks.editorTileAction = (col, row) => editor.handleEditorTileAction(col, row);
    hooks.editorEraseAction = (col, row) => editor.handleEditorEraseAction(col, row);
    hooks.editorDrop = (uid, col, row, duplicate = false) =>
      editor.handleDrop(uid, col, row, { duplicate });
    hooks.getTileCenter = (col, row) => {
      const canvas = document.querySelector(`[data-testid="${OFFICE_CANVAS_TEST_ID}"]`);
      if (!canvas) return null;
      const projection = overlayProjection(
        getOfficeState().getLayout(),
        canvas.getBoundingClientRect(),
        editor.zoom,
        editor.panRef.current,
        window.devicePixelRatio || 1,
      );
      return {
        x: projection.toScreenX((col + 0.5) * TILE_SIZE),
        y: projection.toScreenY((row + 0.5) * TILE_SIZE),
      };
    };
    hooks.getShowAreas = () => effectiveShowAreas;
  }, [
    editor.handleEditorTileAction,
    editor.handleEditorEraseAction,
    editor.handleDrop,
    editor.zoom,
    editor.panRef,
    effectiveShowAreas,
  ]);

  const containerRef = useRef<HTMLDivElement>(null);

  const [editorTickForKeyboard, setEditorTickForKeyboard] = useState(0);
  useEditorKeyboard(
    editor.isEditMode,
    editorState,
    editor.handleDeleteSelected,
    editor.handleRotateSelected,
    editor.handleToggleState,
    editor.handleUndo,
    editor.handleRedo,
    useCallback(() => setEditorTickForKeyboard((n) => n + 1), []),
    editor.handleToggleEditMode,
  );

  const handleCloseAgent = useCallback((id: number) => {
    transport.send({ type: 'closeAgent', id });
  }, []);

  const { reveal: revealTerminal } = terminalDrawer;
  const { showTerminal: showMobileTerminal } = mobileShell;
  // A stream agent's session opens in its own app (⌘/Ctrl-click, double-click,
  // or the Pokédex button). A read-only office would only be refused.
  const openAgentExternally = useCallback(
    (agent: ConductorAgent) => {
      if (!officeReadOnly) openInConductor(agent.externalUrl);
    },
    [officeReadOnly],
  );

  const handleClick = useCallback(
    (agentId: number, mods?: SelectMods) => {
      // If clicked agent is a sub-agent, focus the parent's terminal instead
      const os = getOfficeState();
      const focusId = os.terminalOwnerOf(agentId);
      // Stream (Conductor) agents have no terminal: the click opens their
      // Pokédex (the canvas already toggled the selection). A click that
      // deselected the agent whose Pokédex is open closes it again.
      const streamAgent = conductorStore.getState().agents[focusId];
      if (isStreamAgent(streamAgent)) {
        if (mods?.meta || mods?.double) {
          openAgentExternally(streamAgent);
          setDetailAgentId(focusId);
          return;
        }
        setDetailAgentId((open) =>
          open === focusId && os.selectedAgentId !== focusId ? null : focusId,
        );
        return;
      }
      transport.send({ type: 'focusAgent', id: focusId });
      // Standalone: focusAgent is a no-op server-side (there's no editor to
      // raise a panel in), so focus is resolved here — reveal the agent's tab
      // (desktop drawer) and slide to the terminal page (mobile). A Teammate
      // without a terminal of its own runs in its Lead's, so it reveals that
      // one (VS Code resolves the same way server-side).
      const leadId = os.characters.get(focusId)?.leadAgentId;
      const terminalId =
        leadId !== undefined && !terminalAgentIds.includes(focusId) ? leadId : focusId;
      if (terminalAgentIds.includes(terminalId)) {
        revealTerminal(terminalId);
        if (isMobile) showMobileTerminal();
      }
    },
    [terminalAgentIds, isMobile, revealTerminal, showMobileTerminal, openAgentExternally],
  );

  // Card click when there is no terminal pane to switch (VS Code, or a
  // watch-only standalone session): ask the host to raise the agent's own
  // terminal — VS Code shows the editor terminal, standalone has nothing to
  // show — and select its character so the office follows the click. A
  // stream agent's card selects it and opens its Pokédex instead.
  const handleCardSelect = useCallback(
    (agentId: number, mods?: SelectMods) => {
      const streamAgent = conductorStore.getState().agents[agentId];
      getOfficeState().selectAndFollow(agentId);
      if (isStreamAgent(streamAgent)) {
        if (mods?.meta || mods?.double) openAgentExternally(streamAgent);
        setDetailAgentId(agentId);
        return;
      }
      transport.send({ type: 'focusAgent', id: agentId });
    },
    [openAgentExternally],
  );

  // Mixed mode: cards of agents with a terminal pane are its tabs; every
  // other card (adopted or Conductor agents) selects as above.
  const { select: selectTerminalTab } = terminalDrawer;
  const handleDrawerCardSelect = useCallback(
    (agentId: number, mods?: SelectMods) => {
      if (terminalAgentIds.includes(agentId)) selectTerminalTab(agentId);
      else handleCardSelect(agentId, mods);
    },
    [terminalAgentIds, selectTerminalTab, handleCardSelect],
  );

  // Mobile card tap: stream agents get their Pokédex sheet; the rest keep the
  // shell's two-step focus-then-terminal rule.
  const { selectCard: selectMobileCard } = mobileShell;
  const handleMobileCardSelect = useCallback(
    (agentId: number) => {
      if (isStreamAgent(conductorStore.getState().agents[agentId])) {
        getOfficeState().selectAndFollow(agentId);
        setDetailAgentId(agentId);
        return;
      }
      selectMobileCard(agentId);
    },
    [selectMobileCard],
  );

  // Jump from a Pokédex entry to the peer session it names.
  const handleJumpToAgent = useCallback((agentId: number) => {
    getOfficeState().selectAndFollow(agentId);
    setDetailAgentId(agentId);
  }, []);

  const closeDetail = useCallback(() => setDetailAgentId(null), []);
  const isInOffice = useCallback((id: number) => agents.includes(id), [agents]);

  // The Pokédex closes when its agent leaves the office (hidden, deposited,
  // scoped out).
  const detailAgentPresent = detailAgentId !== null && agents.includes(detailAgentId);
  useEffect(() => {
    if (detailAgentId !== null && !detailAgentPresent) setDetailAgentId(null);
  }, [detailAgentId, detailAgentPresent]);

  // ── Party bar ───────────────────────────────────────────────
  // Theme on: an in-flow party (full slots on wide windows, portraits below),
  // Leads first with their children nested. Theme off: the upstream column.
  const cardBarLayout: CardBarLayout = pokemonTheme ? (wideWindow ? 'wide' : 'compact') : 'overlay';
  const partyEntries = useMemo(
    () =>
      partyOrder(
        agents,
        (id) =>
          conductorAgents[id]?.leadAgentId ?? getOfficeState().characters.get(id)?.leadAgentId,
      ),
    [agents, conductorAgents],
  );
  const cardAgentIds = useMemo(
    () => (pokemonTheme ? partyEntries.map((e) => e.id) : agents),
    [pokemonTheme, partyEntries, agents],
  );
  const slotFor = useMemo(() => {
    if (!pokemonTheme) return undefined;
    const depthById = new Map(partyEntries.map((e) => [e.id, e.depth]));
    const state = { agents: conductorAgents, species: speciesMap };
    return (id: number, now: number) => buildPartySlot(state, id, depthById.get(id) ?? 0, now);
  }, [pokemonTheme, partyEntries, conductorAgents, speciesMap]);
  const cardTitleFor = useCallback((id: number) => conductorAgents[id]?.label, [conductorAgents]);
  // A Conductor agent's × hides its session (the server routes closeAgent).
  const closeTitleFor = useCallback(
    (id: number) => (isStreamAgent(conductorAgents[id]) ? 'Hide session' : 'Close agent'),
    [conductorAgents],
  );
  // A fainted (errored) session's dot turns red; otherwise the drawer's
  // activity reading.
  const { statusFor: drawerStatusFor } = terminalDrawer;
  const cardStatusFor = useCallback(
    (id: number): TabStatus | null =>
      conductorAgents[id]?.status === 'error' ? 'error' : drawerStatusFor(id),
    [conductorAgents, drawerStatusFor],
  );

  const officeState = getOfficeState();

  // Merged set of Directories the Areas dropdown can map: host-contributed ones plus
  // every distinct Directory an agent has run in this session (deduped by name; name
  // is the areaMappings key / seat-bias identity, path is only the React list key).
  const areaDirectories = useMemo(() => {
    const byName = new Map<string, { name: string; path: string }>();
    for (const f of directories) byName.set(f.name, f);
    for (const name of agentDirectoryNames) {
      if (!byName.has(name)) byName.set(name, { name, path: name });
    }
    return [...byName.values()];
  }, [directories, agentDirectoryNames]);

  // The Areas the office defines, offered as a multi-select in the Directory
  // modal. Read straight off the layout (imperative state) on each render, so a
  // layout that loaded — or an Area just added in the editor — is in the list
  // the next time the modal opens.
  const areaLabels = (officeState.getLayout().areas ?? []).map((area) => area.label);

  // Areas authoring is available when the layout already defines areas, or when
  // there is at least one mappable Directory. Decouples the Areas UI from VS Code
  // multi-root workspaces (fixes single-root VS Code AND standalone, where
  // directories is always empty).
  const areasAvailable =
    (officeState.getLayout().areas?.length ?? 0) > 0 || areaDirectories.length > 0;

  const handleExportLayout = useCallback(() => {
    exportLayoutToFile(getOfficeState().getLayout());
  }, []);

  const handleImportLayout = useCallback(
    (file: File) => {
      // Browser-native import (standalone): read + validate + apply directly,
      // bypassing the layoutLoaded message whose dirty guard would skip it.
      if (
        isEditDirty() &&
        !window.confirm('Replace the current layout? Unsaved edits will be lost.')
      ) {
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const imported = JSON.parse(String(reader.result)) as Record<string, unknown>;
          // Match the VS Code guard, plus the furniture-array check VS Code omits
          // (migrate + rebuild iterate furniture and would throw on a non-array).
          if (
            imported.version !== 1 ||
            !Array.isArray(imported.tiles) ||
            !Array.isArray(imported.furniture)
          ) {
            window.alert('Invalid layout file.');
            return;
          }
          const migrated = migrateLayoutColors(imported as unknown as OfficeLayout);
          getOfficeState().rebuildFromLayout(migrated);
          editor.setLastSavedLayout(migrated);
          transport.send({
            type: 'saveLayout',
            layout: migrated as unknown as Record<string, unknown>,
          });
          editor.markClean();
        } catch {
          window.alert('Failed to read or parse layout file.');
        }
      };
      reader.readAsText(file);
    },
    [isEditDirty, editor],
  );

  // Force dependency on editorTickForKeyboard to propagate keyboard-triggered re-renders
  void editorTickForKeyboard;

  // Show "Press R to rotate" hint when a rotatable item is selected or being placed
  const showRotateHint =
    editor.isEditMode &&
    (() => {
      if (editorState.selectedFurnitureUid) {
        const item = officeState
          .getLayout()
          .furniture.find((f) => f.uid === editorState.selectedFurnitureUid);
        if (item && isRotatable(item.type)) return true;
      }
      if (
        editorState.activeTool === EditTool.FURNITURE_PLACE &&
        isRotatable(editorState.placingType)
      ) {
        return true;
      }
      return false;
    })();

  if (!layoutReady) {
    return <div className="w-full h-full flex items-center justify-center ">Loading...</div>;
  }

  // The office region is shared by both shells: desktop mounts it as the
  // flexing left half of the split view (the terminal panel docks beside it);
  // mobile mounts it as the first page of the sliding track. containerRef
  // (ToolOverlay geometry) rides along either way.
  const officeRegion = (
    <div
      ref={containerRef}
      className={`relative h-full overflow-hidden ${isMobile ? 'w-full' : 'flex-1 min-w-0'}`}
    >
      <OfficeCanvas
        officeState={officeState}
        onClick={handleClick}
        isEditMode={editor.isEditMode}
        editorState={editorState}
        onEditorTileAction={editor.handleEditorTileAction}
        onEditorEraseAction={editor.handleEditorEraseAction}
        onEditorSelectionChange={editor.handleEditorSelectionChange}
        onDeleteSelected={editor.handleDeleteSelected}
        onRotateSelected={editor.handleRotateSelected}
        onDrop={editor.handleDrop}
        editorTick={editor.editorTick}
        zoom={editor.zoom}
        onZoomChange={editor.handleZoomChange}
        panRef={editor.panRef}
        showAreas={effectiveShowAreas}
        activeAreaLabel={activeAreaLabel}
        tapSelectsFirst={isMobile}
      />

      {!isDebugMode ? (
        <>
          {/* Mobile: pinch replaces the zoom buttons, and the toolbar's
                jobs move to the card bar (+) and the floating Settings button. */}
          {!isMobile && <ZoomControls zoom={editor.zoom} onZoomChange={editor.handleZoomChange} />}

          {/* Vignette overlay */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ background: 'var(--vignette)' }}
          />

          {editor.isEditMode && editor.isDirty && (
            <EditActionBar editor={editor} editorState={editorState} />
          )}

          {showRotateHint && (
            <div
              className="absolute left-1/2 -translate-x-1/2 z-11 bg-accent-bright text-white text-sm py-3 px-8 rounded-none border-2 border-accent shadow-pixel pointer-events-none whitespace-nowrap"
              style={{ top: editor.isDirty ? 64 : 8 }}
            >
              Rotate (R)
            </div>
          )}

          {editor.isEditMode &&
            (() => {
              const selUid = editorState.selectedFurnitureUid;
              const selColor = selUid
                ? (officeState.getLayout().furniture.find((f) => f.uid === selUid)?.color ?? null)
                : null;
              return (
                <EditorToolbar
                  activeTool={editorState.activeTool}
                  selectedTileType={editorState.selectedTileType}
                  selectedFurnitureType={editorState.placingType}
                  selectedFurnitureUid={selUid}
                  selectedFurnitureColor={selColor}
                  floorColor={editorState.floorColor}
                  wallColor={editorState.wallColor}
                  selectedWallSet={editorState.selectedWallSet}
                  onToolChange={editor.handleToolChange}
                  onTileTypeChange={editor.handleTileTypeChange}
                  onFloorColorChange={editor.handleFloorColorChange}
                  onWallColorChange={editor.handleWallColorChange}
                  onWallSetChange={editor.handleWallSetChange}
                  onSelectedFurnitureColorChange={editor.handleSelectedFurnitureColorChange}
                  pickedFurnitureColor={editorState.pickedFurnitureColor}
                  onPickedFurnitureColorChange={editor.handlePickedFurnitureColorChange}
                  onColorPickToggle={editor.handleColorPickToggle}
                  onFurnitureTypeChange={editor.handleFurnitureTypeChange}
                  loadedAssets={loadedAssets}
                  activePetTypes={officeState.getActivePetTypes()}
                  petCount={getPetCount()}
                  onPetToggle={editor.handlePetToggle}
                  carpetVariant={editor.carpetVariant}
                  carpetColor={editor.carpetColor}
                  carpetAccentColor={editor.carpetAccentColor}
                  onCarpetVariantChange={editor.handleCarpetVariantChange}
                  onCarpetColorChange={editor.handleCarpetColorChange}
                  onCarpetAccentColorChange={editor.handleCarpetAccentColorChange}
                  areas={officeState.getLayout().areas ?? []}
                  selectedAreaLabel={editor.selectedAreaLabel}
                  directories={areaDirectories}
                  areasAvailable={areasAvailable}
                  areaMappings={areaMappings}
                  onSelectArea={editor.handleSelectArea}
                  onAddArea={editor.handleAddArea}
                  onRemoveArea={editor.handleRemoveArea}
                  onRenameArea={editor.handleRenameArea}
                  onAreaColorChange={editor.handleAreaColorChange}
                  onAreaMappingChange={handleAreaMappingChange}
                />
              );
            })()}

          <ToolOverlay
            officeState={officeState}
            agents={agents}
            agentTools={agentTools}
            subagentTools={subagentTools}
            subagentCharacters={subagentCharacters}
            containerRef={containerRef}
            zoom={editor.zoom}
            panRef={editor.panRef}
            onCloseAgent={handleCloseAgent}
            alwaysShowOverlay={alwaysShowOverlay}
          />
        </>
      ) : (
        <DebugView
          agents={agents}
          selectedAgent={selectedAgent}
          agentTools={agentTools}
          agentStatuses={agentStatuses}
          subagentTools={subagentTools}
          officeState={officeState}
          onSelectAgent={handleSelectAgent}
        />
      )}

      {/* Hooks first-run tooltip. Gated on hooksInstalled (the hooksStatus
          message), NOT the hooksEnabled preference: hooksEnabled defaults true
          while first-run consent is still pending, and announcing "Instant
          Detection Active" before anything is installed would be a lie. */}
      {hooksEnabled && claudeHooksInstalled && !hooksInfoShown && !hooksTooltipDismissed && (
        <Tooltip
          title="Instant Detection Active"
          position="top-right"
          onDismiss={() => {
            setHooksTooltipDismissed(true);
            transport.send({ type: 'setHooksInfoShown' });
          }}
        >
          <span className="text-sm text-text leading-none">
            Your agents now respond in real-time.{' '}
            <span
              className="text-accent cursor-pointer underline"
              onClick={() => {
                setIsHooksInfoOpen(true);
                setHooksTooltipDismissed(true);
                transport.send({ type: 'setHooksInfoShown' });
              }}
            >
              View more
            </span>
          </span>
        </Tooltip>
      )}

      {officeReadOnly && (
        <div className="absolute mobile-safe-top left-1/2 -translate-x-1/2 z-10 text-sm text-text-muted pointer-events-none select-none whitespace-nowrap">
          View only
        </div>
      )}

      {/* A read-only office gets no toolbar: launching, layout editing and every
          setting would be refused by the server anyway. */}
      {!isMobile && !officeReadOnly && (
        <BottomToolbar
          isEditMode={editor.isEditMode}
          onToggleEditMode={editor.handleToggleEditMode}
          isSettingsOpen={isSettingsOpen}
          onToggleSettings={() => setIsSettingsOpen((v) => !v)}
          directories={directories}
          onAddDirectory={directoryEditor.add}
          onEditDirectory={directoryEditor.edit}
          terminalAvailable={terminalAvailable}
          terminalUnavailableReason={terminalUnavailableReason}
          claudeActive={claudeActive}
          conductorActive={conductorActive}
          isSessionsOpen={isSessionsOpen}
          onOpenSessions={() => setIsSessionsOpen(true)}
          isPcBoxOpen={isPcBoxOpen}
          onOpenPcBox={() => setIsPcBoxOpen(true)}
        />
      )}

      {/* Mobile: Settings floats top-left (the layout editor stays desktop-
            only — its tools are drag/hover-driven), with Sessions and PC
            beside it when Conductor feeds the office. */}
      {isMobile && !isDebugMode && !officeReadOnly && (
        <div className="absolute mobile-safe-top left-8 z-20 flex gap-4">
          <Button
            size="sm"
            variant={isSettingsOpen ? 'active' : 'default'}
            className="border-border! shadow-pixel"
            onClick={() => setIsSettingsOpen((v) => !v)}
          >
            Settings
          </Button>
          {conductorActive && (
            <>
              <Button
                size="sm"
                variant={isSessionsOpen ? 'active' : 'default'}
                className="border-border! shadow-pixel"
                onClick={() => setIsSessionsOpen(true)}
              >
                Sessions
              </Button>
              <Button
                size="sm"
                variant={isPcBoxOpen ? 'active' : 'default'}
                className="border-border! shadow-pixel"
                onClick={() => setIsPcBoxOpen(true)}
              >
                PC
              </Button>
            </>
          )}
        </div>
      )}

      {/* Conductor on and nobody here: sign-in steps or "No sessions in scope". */}
      {conductorActive && agents.length === 0 && !isDebugMode && (
        <ConductorEmptyOffice
          onOpenSessions={officeReadOnly ? null : () => setIsSessionsOpen(true)}
        />
      )}

      {pokemonTheme && battleLogOn && !isDebugMode && (
        <BattleLog bottomPx={isMobile ? BATTLE_LOG_BOTTOM_MOBILE_PX : BATTLE_LOG_BOTTOM_PX} />
      )}

      {/* Narrow desktop windows: the Pokédex opens as a drawer over the
          office's right edge (clear of the upstream card column, which
          overlays that edge when the theme is off). */}
      {!isMobile && !wideWindow && detailAgentPresent && detailAgentId !== null && (
        <SessionPanel
          key={detailAgentId}
          agentId={detailAgentId}
          mode="drawer"
          rightInsetPx={cardBarLayout === 'overlay' ? TERMINAL_SIDEBAR_WIDTH_PX : 0}
          readOnly={officeReadOnly}
          appearance={terminalDrawer.getAppearance(detailAgentId)}
          isInOffice={isInOffice}
          onJump={handleJumpToAgent}
          onClose={closeDetail}
        />
      )}

      <VersionIndicator
        currentVersion={extensionVersion}
        lastSeenVersion={lastSeenVersion}
        hideUpdateNotice={officeReadOnly}
        onDismiss={handleWhatsNewDismiss}
        onOpenChangelog={handleOpenChangelog}
      />

      {intro && (
        <IntroBubble
          officeState={officeState}
          headline={intro.headline}
          disclosure={intro.disclosure}
          containerRef={containerRef}
          zoom={editor.zoom}
          panRef={editor.panRef}
          installFailed={installFailed}
          installPending={installPending}
          onChoice={handleConsentChoice}
          onClose={handleIntroClose}
          escapeSuppressed={
            isSettingsOpen ||
            isChangelogOpen ||
            isHooksInfoOpen ||
            isSessionsOpen ||
            isPcBoxOpen ||
            isCreditsOpen ||
            showMigrationNotice ||
            editor.isEditMode
          }
        />
      )}

      <ConnectionIndicator />
    </div>
  );

  // Wide windows dock the Pokédex as a flex sibling of the office.
  const dockedPanel = wideWindow && detailAgentPresent && detailAgentId !== null && (
    <SessionPanel
      key={detailAgentId}
      agentId={detailAgentId}
      mode="docked"
      readOnly={officeReadOnly}
      appearance={terminalDrawer.getAppearance(detailAgentId)}
      isInOffice={isInOffice}
      onJump={handleJumpToAgent}
      onClose={closeDetail}
    />
  );

  return (
    // Desktop: split view — the office region flexes to fill the space left of
    // the terminal panel. Mobile: a column — the sliding office/terminal track
    // on top, the agent-card bar pinned along the bottom.
    <div
      className={`w-full h-full relative overflow-hidden flex ${isMobile ? 'flex-col' : ''}`}
      style={
        isMobile && keyboard.clampHeight !== null ? { height: keyboard.clampHeight } : undefined
      }
    >
      {isMobile ? (
        <MobileShell
          office={officeRegion}
          shell={mobileShell}
          drawer={terminalDrawer}
          agentIds={cardAgentIds}
          terminalAgentIds={terminalAgentIds}
          focusedAgentId={focusedAgentId}
          terminalAvailable={terminalAvailable}
          terminalUnavailableReason={terminalUnavailableReason}
          directories={directories}
          onAddDirectory={directoryEditor.add}
          onEditDirectory={directoryEditor.edit}
          onCloseAgent={handleCloseAgent}
          keyboardOpen={keyboard.keyboardOpen}
          onSelectCard={handleMobileCardSelect}
          showLaunch={claudeActive}
          slotFor={slotFor}
        />
      ) : (
        <>
          {officeRegion}

          {/* Party layouts: the Pokédex docks between the office and the
              party, so the office reflows and the party never moves. */}
          {cardBarLayout !== 'overlay' && dockedPanel}

          {/* Standalone with a terminal: terminalAvailable is only ever true when
              the server reports a working PTY to a tokened session, which VS
              Code's surface never does. In flow as a flex sibling so the office
              region reflows beside it instead of being overlaid.

              Otherwise (VS Code, or a watch-only standalone session) the card
              bar stands alone with every agent in the office, external sessions
              included — the at-a-glance "who needs attention" strip, with a
              click raising the agent's editor terminal where there is one. */}
          {terminalAvailable ? (
            <TerminalDrawer
              agentIds={terminalAgentIds}
              shownAgentId={terminalDrawer.shownAgentId}
              cardBar={
                <AgentCardBar
                  agentIds={cardAgentIds}
                  activeAgentId={terminalDrawer.shownAgentId}
                  focusedAgentId={focusedAgentId}
                  getAppearance={terminalDrawer.getAppearance}
                  statusFor={cardStatusFor}
                  onSelect={handleDrawerCardSelect}
                  onClose={handleCloseAgent}
                  layout={cardBarLayout}
                  slotFor={slotFor}
                  titleFor={cardTitleFor}
                  closeTitleFor={closeTitleFor}
                />
              }
              isOpen={terminalDrawer.isOpen}
              onClosePanel={terminalDrawer.close}
              widthPx={terminalDrawer.widthPx}
              onResizeStart={terminalDrawer.onResizeStart}
              onStatusChange={terminalDrawer.onStatusChange}
            />
          ) : (
            !isDebugMode && (
              <AgentCardBar
                agentIds={cardAgentIds}
                focusedAgentId={focusedAgentId}
                getAppearance={terminalDrawer.getAppearance}
                statusFor={cardStatusFor}
                onSelect={handleCardSelect}
                onClose={handleCloseAgent}
                layout={cardBarLayout}
                slotFor={slotFor}
                titleFor={cardTitleFor}
                closeTitleFor={closeTitleFor}
              />
            )
          )}

          {/* Upstream card column: it overlays whatever sits to its left, so
              the Pokédex docks on its right instead. */}
          {cardBarLayout === 'overlay' && dockedPanel}
        </>
      )}

      {/* Hooks info modal. Top level, beside the other modals: inside the
          office region it would sit in the mobile shell's transformed track,
          and a transformed ancestor is the containing block of position:
          fixed — the modal would size to the 200%-wide track. */}
      <Modal
        isOpen={isHooksInfoOpen}
        onClose={() => setIsHooksInfoOpen(false)}
        title="Instant Detection is ON"
        zIndex={52}
      >
        <div className="text-base text-text px-10" style={{ lineHeight: 1.4 }}>
          <p className="mb-8">Your Poke Agents office now reacts in real-time:</p>
          <ul className="mb-8 pl-18 list-disc m-0">
            <li className="text-sm mb-2">Permission prompts appear instantly</li>
            <li className="text-sm mb-2">Turn completions detected the moment they happen</li>
            <li className="text-sm mb-2">Sound notifications play immediately</li>
          </ul>
          <p className="mb-12 text-text-muted">
            This works through Claude Code Hooks, small event listeners that notify Poke Agents
            whenever something happens in your Claude sessions.
          </p>
          <div className="text-center">
            <button
              onClick={() => setIsHooksInfoOpen(false)}
              className="py-4 px-20 text-lg bg-accent text-white border-2 border-accent rounded-none cursor-pointer shadow-pixel"
            >
              Got it
            </button>
          </div>
          <p className="mt-8 text-xs text-text-muted text-center">
            To disable, go to Settings {'>'} Instant Detection
          </p>
        </div>
      </Modal>
      {/* Rendered at the composition root, not inside a launch surface: the
          drawer that opens it lives in BottomToolbar on desktop and
          MobileAgentBar on mobile, and both close as soon as it appears. */}
      <DirectoryModal
        isOpen={directoryEditor.modal.open}
        editing={directoryEditor.modal.editing}
        error={directoryEditor.error}
        suggestions={directorySuggestions}
        areas={areaLabels}
        assignedAreas={directoryEditor.assignedAreas}
        onSubmit={directoryEditor.submit}
        onDelete={directoryEditor.remove}
        onClose={directoryEditor.close}
      />

      <ChangelogModal
        isOpen={isChangelogOpen}
        onClose={() => setIsChangelogOpen(false)}
        currentVersion={extensionVersion}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        isDebugMode={isDebugMode}
        onToggleDebugMode={handleToggleDebugMode}
        alwaysShowOverlay={alwaysShowOverlay}
        onToggleAlwaysShowOverlay={handleToggleAlwaysShowOverlay}
        ghostHeadlessAgents={ghostHeadlessAgents}
        onToggleGhostHeadlessAgents={handleToggleGhostHeadlessAgents}
        externalAssetDirectories={externalAssetDirectories}
        watchAllSessions={watchAllSessions}
        onToggleWatchAllSessions={() => {
          const newVal = !watchAllSessions;
          setWatchAllSessions(newVal);
          transport.send({ type: 'setWatchAllSessions', enabled: newVal });
        }}
        hooksInstalled={claudeHooksInstalled}
        onToggleHooksEnabled={() => {
          // Toggle the DISPLAYED state (actual install), not the preference: when the two disagree — preference on,
          // nothing installed while consent is pending — toggling the preference would turn hooks OFF for a user
          // asking for ON. No optimistic local update either; both backends answer with the truthful hooksStatus this
          // checkbox renders, so it lands correct instead of flickering when an install fails. The providerId is
          // ECHOED from that row (never originated here), so nothing sends until the row has arrived.
          const [rowProviderId] =
            Object.entries(hooksInstalled).find(([id]) => id === 'claude') ?? [];
          if (rowProviderId !== undefined) {
            transport.send({
              type: 'setHooksEnabled',
              providerId: rowProviderId,
              enabled: !claudeHooksInstalled,
            });
          }
        }}
        showAreas={showAreas}
        onToggleShowAreas={onToggleShowAreas}
        showAreasAvailable={areasAvailable}
        bypassPermissions={bypassPermissions}
        onToggleBypassPermissions={() => {
          const newVal = !bypassPermissions;
          setBypassPermissions(newVal);
          transport.send({ type: 'setBypassPermissions', enabled: newVal });
        }}
        showHostDirectories={showHostDirectories}
        onToggleShowHostDirectories={() => {
          const newVal = !showHostDirectories;
          setShowHostDirectories(newVal);
          transport.send({ type: 'setShowHostDirectories', enabled: newVal });
        }}
        onExportLayout={handleExportLayout}
        onImportLayout={handleImportLayout}
        claudeActive={claudeActive}
        conductorActive={conductorActive}
        onManageSessions={() => setIsSessionsOpen(true)}
        onOpenPcBox={() => setIsPcBoxOpen(true)}
        pokemonTheme={pokemonTheme}
        onTogglePokemonTheme={() => setPokemonTheme(!pokemonTheme)}
        showConnections={showConnections}
        onToggleShowConnections={() => setShowConnections(!showConnections)}
        battleLog={battleLogOn}
        onToggleBattleLog={() => setBattleLogOn(!battleLogOn)}
        onOpenCredits={() => setIsCreditsOpen(true)}
      />

      {/* Conductor surfaces. Top level for the same reason as the modals
          above: the mobile track's transform would capture position:fixed. */}
      <SessionsModal
        isOpen={isSessionsOpen}
        onClose={() => setIsSessionsOpen(false)}
        readOnly={officeReadOnly}
      />
      <PcBoxModal
        isOpen={isPcBoxOpen}
        onClose={() => setIsPcBoxOpen(false)}
        readOnly={officeReadOnly}
      />
      <CreditsModal isOpen={isCreditsOpen} onClose={() => setIsCreditsOpen(false)} />
      {isMobile && detailAgentPresent && detailAgentId !== null && (
        <SessionPanel
          key={detailAgentId}
          agentId={detailAgentId}
          mode="sheet"
          readOnly={officeReadOnly}
          appearance={terminalDrawer.getAppearance(detailAgentId)}
          isInOffice={isInOffice}
          onJump={handleJumpToAgent}
          onClose={closeDetail}
        />
      )}
      <Toasts />

      {showMigrationNotice && (
        <MigrationNotice onDismiss={() => setMigrationNoticeDismissed(true)} />
      )}
    </div>
  );
}

export default App;
