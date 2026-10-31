/**
 * One soundtrack at a time: starting a source pauses the one that was playing.
 * Radio and folder music share the page's player, so switching between them
 * only changes what it plays; an app source pauses it. DOM-free (the player,
 * the transport and storage are injected) so the rule is tested in Node;
 * controls.ts wires it to the page.
 */

import type { MusicSourceId } from '../../../core/src/messages.js';
import { type AppSource, isPageSource, type MusicStore } from './musicStore.js';

export interface SourceSwitchDeps {
  store: Pick<MusicStore, 'getState' | 'setActiveSource'>;
  /** Pause the page's player (radio or folder music), when the page has one. */
  pauseFolder(): void;
  /** Ask an app to pause. */
  pauseApp(source: AppSource): void;
  /** Remember the source for the next visit. */
  remember(source: MusicSourceId): void;
}

/** Make `source` the one that plays, pausing the other first. */
export function activateSource(source: MusicSourceId, deps: SourceSwitchDeps): void {
  const { activeSource, apps } = deps.store.getState();
  if (!isPageSource(source)) deps.pauseFolder();
  if (source !== activeSource && !isPageSource(activeSource) && apps[activeSource]?.playing) {
    deps.pauseApp(activeSource);
  }
  deps.store.setActiveSource(source);
  deps.remember(source);
}
