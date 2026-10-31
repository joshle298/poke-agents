/**
 * About & credits names every Poke Agents Radio track as CC BY asks: title,
 * author, a link to the license and a link to the page it comes from. The
 * modal is rendered to static markup (react-dom/server, no DOM).
 *
 * Run with: npm test
 */

import type { FunctionComponent } from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RADIO_CREDITS, RADIO_STATION_NAME } from '../../core/src/radioCredits.js';

// The species list reads the Conductor store through useSyncExternalStore,
// which server rendering can't subscribe to; no species are loaded here.
vi.mock('../src/conductor/conductorStore.js', () => ({
  useConductor: <T>(select: (state: { species: Record<string, never> }) => T) =>
    select({ species: {} }),
}));

/** The test tsconfig has no JSX or DOM lib, so the .tsx module is imported
 *  untyped and its props described here. */
const MODAL_MODULE = '../src/components/CreditsModal.js';
let CreditsModal: FunctionComponent<{ isOpen: boolean; onClose: () => void }>;

beforeAll(async () => {
  // The module graph reaches the transport, which reads the page's location.
  vi.stubGlobal('window', {
    location: { protocol: 'http:', host: 'localhost:41510', search: '' },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  ({ CreditsModal } = (await import(/* @vite-ignore */ MODAL_MODULE)) as {
    CreditsModal: typeof CreditsModal;
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#x27;');

describe('Radio credits in About & credits', () => {
  it('lists every track with its author, license link and source link', () => {
    const html = renderToStaticMarkup(
      createElement(CreditsModal, { isOpen: true, onClose: () => {} }),
    );
    const section = html.slice(html.indexOf('data-testid="radio-credits"'));
    expect(section).toContain(RADIO_STATION_NAME);
    for (const credit of RADIO_CREDITS) {
      expect(section).toContain(escape(credit.title));
      expect(section).toContain(escape(credit.author));
      expect(section).toContain(`href="${escape(credit.license.url)}"`);
      expect(section).toContain(`>${credit.license.name}</a>`);
      expect(section).toContain(`href="${escape(credit.sourceUrl)}"`);
    }
    expect(section.match(/<li /g)).toHaveLength(RADIO_CREDITS.length);
  });
});
