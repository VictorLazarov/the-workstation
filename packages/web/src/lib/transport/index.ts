import { getToken, isDemo } from '../storage';
import type { Transport } from './types';
import { WsTransport } from './ws';

export type { Transport, ConnStatus } from './types';

export async function createTransport(): Promise<Transport> {
  if (isDemo()) return (await import('../demo/server')).createDemoTransport();
  return new WsTransport(getToken());
}
