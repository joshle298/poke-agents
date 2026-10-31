/**
 * One soundtrack at a time: starting a source pauses the one that was playing.
 * DOM-free (the folder player, the transport and storage are injected) so the
 * rule is tested in Node; controls.ts wires it to the page.
 */

import type { MusicSourceId } from '../../../core/src/messages.js';
import type { AppSource, MusicStore } from './musicStore.js';

export interface SourceSwitchDeps {
  store: Pick<MusicStore, 'getState' | 'setActiveSource'>;
  /** Pause folder music (when the page has a folder player). */
  pauseFolder(): void;
  /** Ask an app to pause. */
  pauseApp(source: AppSource): void;
  /** Remember the source for the next visit. */
  remember(source: MusicSourceId): void;
}

/** Make `source` the one that plays, pausing the other first. */
export function activateSource(source: MusicSourceId, deps: SourceSwitchDeps): void {
  const { activeSource, apps } = deps.store.getState();
  if (source !== 'folder') deps.pauseFolder();
  if (source !== activeSource && activeSource !== 'folder' && apps[activeSource]?.playing) {
    deps.pauseApp(activeSource);
  }
  deps.store.setActiveSource(source);
  deps.remember(source);
}
