/**
 * The office's message stream, for the desktop's notifications and Dock
 * badge: the same messages an office window receives, from whichever process
 * serves the office. Nothing here changes the office or talks to Conductor.
 */

import { agentCreatedMessage } from '../../server/src/agentMessages.js';
import type { AgentStateStore } from '../../server/src/agentStateStore.js';
import type { AgentState } from '../../server/src/types.js';

export type OfficeMessage = Record<string, unknown>;
export type OfficeListener = (message: OfficeMessage) => void;

/**
 * In-process office: the store's events, shaped as the WebSocket route sends
 * them (agentAdded → agentCreated, agentRemoved → agentClosed, broadcasts as
 * they are). Returns the unsubscribe.
 */
export function feedFromStore(store: AgentStateStore, listener: OfficeListener): () => void {
  const onAdded = (id: number, agent: AgentState): void => {
    listener({ ...agentCreatedMessage(id, agent) });
  };
  const onRemoved = (id: number): void => listener({ type: 'agentClosed', id });
  const onBroadcast = (message: OfficeMessage): void => listener(message);
  store.on('agentAdded', onAdded);
  store.on('agentRemoved', onRemoved);
  store.on('broadcast', onBroadcast);
  return () => {
    store.off('agentAdded', onAdded);
    store.off('agentRemoved', onRemoved);
    store.off('broadcast', onBroadcast);
  };
}

/** The slice of the WebSocket API the feed uses (the global one in Node 22+). */
export interface FeedSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface OfficeSubscription {
  close(): void;
}

export interface SubscribeOptions {
  /** `ws://host:port/ws` of the running office. No token: the feed only
   *  watches, so it connects without privilege. */
  url: string;
  listener: OfficeListener;
  /** Called on every (re)connect, before the office replays its state. */
  onConnect?: () => void;
  retryMs: number;
  createSocket?: (url: string) => FeedSocket;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/**
 * Office another process serves (a reused `poke-agents` server): a read-only
 * WebSocket that asks for the office's state (`webviewReady`) and then
 * receives every broadcast. Reconnects after `retryMs` until closed.
 */
export function subscribeToOffice(options: SubscribeOptions): OfficeSubscription {
  const createSocket =
    options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as FeedSocket);
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let socket: FeedSocket | null = null;
  let retry: unknown = null;
  let closed = false;

  const connect = (): void => {
    retry = null;
    if (closed) return;
    const ws = createSocket(options.url);
    socket = ws;
    ws.onopen = () => {
      options.onConnect?.();
      ws.send(JSON.stringify({ type: 'webviewReady' }));
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
        options.listener(message as OfficeMessage);
      }
    };
    ws.onerror = () => {
      // onclose follows and schedules the retry.
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      if (!closed && retry === null) retry = setTimer(connect, options.retryMs);
    };
  };

  connect();
  return {
    close() {
      closed = true;
      if (retry !== null) clearTimer(retry);
      retry = null;
      socket?.close();
      socket = null;
    },
  };
}
