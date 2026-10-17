import type { ClientMessage, ServerMessage } from '@workstation/protocol';

export type ConnStatus = 'connecting' | 'open' | 'closed';

/** Abstraction over the server connection. Real = WebSocket, demo = in-browser fake server. */
export interface Transport {
  readonly status: ConnStatus;
  connect(): void;
  close(): void;
  /** returns false when the message could not be sent (not connected) */
  send(msg: ClientMessage): boolean;
  onMessage(cb: (m: ServerMessage) => void): () => void;
  onStatus(cb: (s: ConnStatus) => void): () => void;
}
