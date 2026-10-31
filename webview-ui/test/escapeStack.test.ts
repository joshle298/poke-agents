/**
 * One Escape model for the surfaces stacked over the office: the topmost
 * open one closes, nothing beneath it reacts, and a text field keeps Escape
 * away from the Pokédex.
 *
 * Run with: npm test
 */

import { describe, expect, it } from 'vitest';

import { EscapeStack } from '../src/escapeStack.js';

const POKEDEX_Z = 44;
const INTRO_Z = 45;
const MODAL_Z = 50;
const CONFIRM_Z = 56;

const escape = { key: 'Escape', inField: false };

function surfaces() {
  const stack = new EscapeStack();
  const closed: string[] = [];
  const open = (name: string, z: number, closeFromFields?: boolean) =>
    stack.push(() => closed.push(name), { z, closeFromFields });
  return { stack, closed, open };
}

describe('EscapeStack', () => {
  it('closes a modal opened over the Pokédex, and only the modal', () => {
    const { stack, closed, open } = surfaces();
    open('pokedex', POKEDEX_Z, false);
    const closeSessions = open('sessions', MODAL_Z);

    expect(stack.handle(escape)).toBe(true);
    expect(closed).toEqual(['sessions']);

    // The modal unmounts; the next Escape reaches the Pokédex.
    closeSessions();
    expect(stack.handle(escape)).toBe(true);
    expect(closed).toEqual(['sessions', 'pokedex']);
  });

  it('a confirmation inside the Pokédex closes before the Pokédex', () => {
    const { stack, closed, open } = surfaces();
    open('pokedex', POKEDEX_Z, false);
    open('stop-confirm', CONFIRM_Z);
    stack.handle(escape);
    expect(closed).toEqual(['stop-confirm']);
  });

  it('goes by z first, then by the newest layer', () => {
    const { stack, closed, open } = surfaces();
    // A Pokédex remounted after a modal opened (a resize swaps its layout)
    // still sits under the modal.
    open('settings', MODAL_Z);
    open('pokedex', POKEDEX_Z, false);
    stack.handle(escape);
    expect(closed).toEqual(['settings']);

    open('credits', MODAL_Z);
    stack.handle(escape);
    expect(closed).toEqual(['settings', 'credits']);
  });

  it('keeps the Intro under modals and over the Pokédex', () => {
    const { stack, closed, open } = surfaces();
    open('intro', INTRO_Z);
    open('pokedex', POKEDEX_Z, false);
    stack.handle(escape);
    expect(closed).toEqual(['intro']);
  });

  it('lets Escape typed in a field through when the top layer keeps fields', () => {
    const { stack, closed, open } = surfaces();
    open('pokedex', POKEDEX_Z, false);
    // The reply box (or a terminal beside the panel) keeps the key.
    expect(stack.handle({ key: 'Escape', inField: true })).toBe(false);
    expect(closed).toEqual([]);

    // A modal closes from its own search box.
    open('sessions', MODAL_Z);
    expect(stack.handle({ key: 'Escape', inField: true })).toBe(true);
    expect(closed).toEqual(['sessions']);
  });

  it('ignores other keys, an Escape that cancels an IME composition, and an empty stack', () => {
    const { stack, closed, open } = surfaces();
    expect(stack.handle(escape)).toBe(false);
    open('sessions', MODAL_Z);
    expect(stack.handle({ key: 'Enter', inField: false })).toBe(false);
    expect(stack.handle({ key: 'Escape', inField: false, isComposing: true })).toBe(false);
    expect(closed).toEqual([]);
  });

  it('removing a layer twice is harmless', () => {
    const { stack, open } = surfaces();
    const remove = open('sessions', MODAL_Z);
    remove();
    remove();
    expect(stack.size).toBe(0);
  });
});
