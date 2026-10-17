import type { ClientMessage, ServerMessage } from '@workstation/protocol';

/** `offline`: automatic retries are exhausted; the user can retry (Retry button, or the window coming back online). */
export type ConnStatus = 'connecting' | 'open' | 'closed' | 'offline';

/** Abstraction over the server connection. Real = WebSocket, demo = in-browser fake server. */
export interface Transport {
  readonly status: ConnStatus;
  /** (Re)connects now. Also resets the retry budget, so it is what the Retry button calls. */
  connect(): void;
  close(): void;
  /** returns false when the message could not be sent (not connected) */
  send(msg: ClientMessage): boolean;
  onMessage(cb: (m: ServerMessage) => void): () => void;
  onStatus(cb: (s: ConnStatus) => void): () => void;
}
