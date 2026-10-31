import { describe, expect, it, vi } from 'vitest';

import {
  ACTIVATION_EVENTS,
  grantsUserActivation,
  JUKEBOX_UI_ATTRIBUTE,
  resumeOnGesture,
} from '../src/music/resumeOnGesture.js';

type Listener = (e: { type: string; key?: string; pointerType?: string; target?: unknown }) => void;

/** A window stand-in: capture listeners by type. */
function fakeWindow() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener(type: string, fn: Listener, capture: boolean) {
      expect(capture).toBe(true);
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(e: { type: string; key?: string; pointerType?: string; target?: unknown }) {
      for (const fn of [...(listeners.get(e.type) ?? [])]) fn(e);
    },
    count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

/** An element, inside the Jukebox or not. */
function element(insideJukebox: boolean) {
  return {
    closest: (selector: string) =>
      insideJukebox && selector === `[${JUKEBOX_UI_ATTRIBUTE}]` ? {} : null,
  };
}

const office = element(false);

describe('grantsUserActivation', () => {
  it('counts the gestures browsers let start audio, and nothing else', () => {
    expect(grantsUserActivation({ type: 'keydown', key: 'a' })).toBe(true);
    expect(grantsUserActivation({ type: 'keydown', key: ' ' })).toBe(true);
    expect(grantsUserActivation({ type: 'keydown', key: 'Escape' })).toBe(false);
    expect(grantsUserActivation({ type: 'pointerdown', pointerType: 'mouse' })).toBe(true);
    // A finger or pen counts when it lifts, not when it lands.
    expect(grantsUserActivation({ type: 'pointerdown', pointerType: 'touch' })).toBe(false);
    expect(grantsUserActivation({ type: 'pointerdown', pointerType: 'pen' })).toBe(false);
    expect(grantsUserActivation({ type: 'pointerup', pointerType: 'touch' })).toBe(true);
    expect(grantsUserActivation({ type: 'pointerup', pointerType: 'pen' })).toBe(true);
    expect(grantsUserActivation({ type: 'pointerup', pointerType: 'mouse' })).toBe(false);
    expect(grantsUserActivation({ type: 'touchend' })).toBe(true);
    expect(grantsUserActivation({ type: 'scroll' })).toBe(false);
  });
});

describe('resumeOnGesture', () => {
  it('resumes on the first activating gesture outside the Jukebox, once', () => {
    const target = fakeWindow();
    const resume = vi.fn();
    resumeOnGesture({ target, shouldResume: () => true, resume });
    expect(target.count()).toBe(ACTIVATION_EVENTS.length);

    target.dispatch({ type: 'pointerdown', pointerType: 'touch', target: office });
    target.dispatch({ type: 'keydown', key: 'Escape', target: office });
    expect(resume).not.toHaveBeenCalled();

    target.dispatch({ type: 'pointerup', pointerType: 'touch', target: office });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(target.count()).toBe(0);
    target.dispatch({ type: 'keydown', key: 'a', target: office });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('leaves gestures inside the Jukebox to the Jukebox and keeps listening', () => {
    const target = fakeWindow();
    const resume = vi.fn();
    resumeOnGesture({ target, shouldResume: () => true, resume });
    target.dispatch({ type: 'pointerdown', pointerType: 'mouse', target: element(true) });
    expect(resume).not.toHaveBeenCalled();
    expect(target.count()).toBe(ACTIVATION_EVENTS.length);
    target.dispatch({ type: 'pointerdown', pointerType: 'mouse', target: office });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('listens again after a blocked start, so the next gesture tries again', () => {
    const target = fakeWindow();
    const resume = vi.fn((onBlocked: () => void) => onBlocked());
    resumeOnGesture({ target, shouldResume: () => true, resume });
    target.dispatch({ type: 'keydown', key: 'a', target: office });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(target.count()).toBe(ACTIVATION_EVENTS.length);
    target.dispatch({ type: 'touchend', target: office });
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('stops when the music was paused or switched meanwhile, or on cleanup', () => {
    const target = fakeWindow();
    const resume = vi.fn();
    resumeOnGesture({ target, shouldResume: () => false, resume });
    target.dispatch({ type: 'keydown', key: 'a', target: office });
    expect(resume).not.toHaveBeenCalled();
    expect(target.count()).toBe(0);

    const other = fakeWindow();
    let blocked: (() => void) | null = null;
    const cleanup = resumeOnGesture({
      target: other,
      shouldResume: () => true,
      resume: (onBlocked) => {
        blocked = onBlocked;
      },
    });
    other.dispatch({ type: 'keydown', key: 'a', target: office });
    cleanup();
    // A refusal that arrives after unmount doesn't listen again.
    blocked!();
    expect(other.count()).toBe(0);
  });
});
