import type { ImageAttachment } from '@workstation/protocol';

/** A message waiting to be sent. `failed`: it never reached the server (offline / session ended) and needs a retry. */
export interface QueuedPrompt { id: string; text: string; images: ImageAttachment[]; failed?: boolean }

export const markAllFailed = (q: QueuedPrompt[]): QueuedPrompt[] => q.map((x) => (x.failed ? x : { ...x, failed: true }));
export const clearFailed = (q: QueuedPrompt[]): QueuedPrompt[] => q.map((x) => (x.failed ? { ...x, failed: false } : x));
export const hasFailed = (q: QueuedPrompt[]): boolean => q.some((x) => x.failed);
/** The next message that may be sent now (failed ones wait for an explicit retry or a reconnect). */
export const nextSendable = (q: QueuedPrompt[]): QueuedPrompt | undefined => q.find((x) => !x.failed);
/** Puts a message that could not be sent back into the queue, marked failed (adds it if it was not queued yet). */
export function failMessage(q: QueuedPrompt[], m: { id: string; text: string; images: ImageAttachment[] }): QueuedPrompt[] {
  return q.some((x) => x.id === m.id) ? q.map((x) => (x.id === m.id ? { ...x, failed: true } : x)) : [...q, { ...m, failed: true }];
}
