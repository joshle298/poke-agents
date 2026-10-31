import {
  TRANSPORT_STATE_CONNECTED,
  TRANSPORT_STATE_CONNECTING,
  TRANSPORT_STATE_DISCONNECTED,
  TRANSPORT_STATE_RECONNECTING,
} from '../../../core/src/constants.js';
import type { ClientMessage, ServerMessage } from '../../../core/src/messages.js';
import { WS_CLOSE_FORBIDDEN_HOST_CODE, WS_CLOSE_FORBIDDEN_HOST_REASON } from '../constants.js';
import { reconnectDelayMs } from './reconnectBackoff.js';
import type { MessageTransport, TransportState } from './types.js';

/** What to tell the user when the server refused this page's address. */
export function refusedHostMessage(hostname: string): string {
  return `This address isn't allowed. Restart poke-agents with --allowed-host ${hostname}.`;
}

/**
 * WebSocket transport for standalone browser mode.
 * Connects to the Pixel Agents server via WebSocket for bidirectional messaging.
 * Includes automatic reconnection with exponential backoff and message queuing.
 */
export class WebSocketTransport implements MessageTransport {
  private ws: WebSocket | null = null;
  private handlers: Array<(msg: ServerMessage) => void> = [];
  private stateHandlers: Array<(state: TransportState) => void> = [];
  private url: string;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private pendingMessages: ClientMessage[] = [];
  private _state: TransportState = TRANSPORT_STATE_CONNECTING;
  private _refusedHost = false;
  private readonly _ready: Promise<void>;
  private resolveReady!: () => void;

  constructor(url: string) {
    this.url = url;
    this._ready = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  get state(): TransportState {
    return this._state;
  }

  get ready(): Promise<void> {
    return this._ready;
  }

  /** The server refused this page's address (a DNS name it doesn't allow).
   *  Reconnecting can't help, so the transport stops and stays disconnected. */
  get refusedHost(): boolean {
    return this._refusedHost;
  }

  private setState(next: TransportState): void {
    if (this._state === next) return;
    this._state = next;
    for (const handler of this.stateHandlers) handler(next);
  }

  connect(): void {
    if (this.disposed) return;

    // First attempt is "connecting"; any retry after a drop is "reconnecting".
    this.setState(
      this.reconnectAttempts > 0 ? TRANSPORT_STATE_RECONNECTING : TRANSPORT_STATE_CONNECTING,
    );

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      console.log('[Transport] WebSocket connected');
      this.setState(TRANSPORT_STATE_CONNECTED);
      this.resolveReady();
      // Flush any messages queued while connecting
      for (const msg of this.pendingMessages) {
        this.ws!.send(JSON.stringify(msg));
      }
      this.pendingMessages = [];
    };

    this.ws.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as ServerMessage;
        for (const handler of this.handlers) handler(msg);
      } catch {
        // Malformed JSON, ignore
      }
    };

    this.ws.onclose = (event: CloseEvent) => {
      if (this.disposed) return;
      if (
        event.code === WS_CLOSE_FORBIDDEN_HOST_CODE &&
        event.reason === WS_CLOSE_FORBIDDEN_HOST_REASON
      ) {
        this._refusedHost = true;
        this.setState(TRANSPORT_STATE_DISCONNECTED);
        return;
      }
      this.setState(TRANSPORT_STATE_RECONNECTING);
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror, triggering reconnect
    };
  }

  send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      // Queue messages while connecting (flushed in onopen)
      this.pendingMessages.push(message);
    }
  }

  onMessage(handler: (message: ServerMessage) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /**
   * Deliver an externally-sourced message to all handlers, as if it had arrived
   * over the socket. Used in Vite dev mode to bridge `browserMock`'s injected
   * `window` messages (there is no real server to connect to in dev).
   */
  deliver(message: ServerMessage): void {
    for (const handler of this.handlers) handler(message);
  }

  onStateChange(handler: (state: TransportState) => void): () => void {
    this.stateHandlers.push(handler);
    return () => {
      this.stateHandlers = this.stateHandlers.filter((h) => h !== handler);
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.handlers = [];
    this.pendingMessages = [];
    this.setState(TRANSPORT_STATE_DISCONNECTED);
    this.stateHandlers = [];
  }

  private scheduleReconnect(): void {
    const delay = reconnectDelayMs(this.reconnectAttempts);
    this.reconnectAttempts++;

    console.log(
      `[Transport] WebSocket reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
