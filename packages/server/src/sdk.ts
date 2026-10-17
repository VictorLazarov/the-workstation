import * as realSdk from '@anthropic-ai/claude-agent-sdk';
import type {
  ModelInfo, Options, PermissionMode as SdkPermissionMode, Query, SDKSessionInfo, SDKUserMessage, SessionMessage, SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { createMockAdapter } from './mock.js';

/** The subset of the SDK Query surface the server uses (implemented by the real SDK and the mock). */
export interface QueryHandle extends AsyncGenerator<unknown, void> {
  interrupt(): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: SdkPermissionMode): Promise<void>;
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>;
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<unknown>;
  mcpServerStatus(): Promise<unknown[]>;
  toggleMcpServer(name: string, enabled: boolean): Promise<void>;
  reconnectMcpServer(name: string): Promise<void>;
  initializationResult(): Promise<{ commands?: SlashCommand[]; models?: ModelInfo[]; [k: string]: unknown }>;
  supportedModels(): Promise<ModelInfo[]>;
  supportedCommands(): Promise<SlashCommand[]>;
  close(): void;
}

export interface SdkAdapter {
  readonly mock: boolean;
  query(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): QueryHandle;
  listSessions(opts?: { dir?: string; limit?: number }): Promise<SDKSessionInfo[]>;
  getSessionMessages(id: string, opts?: { dir?: string }): Promise<SessionMessage[]>;
  renameSession(id: string, title: string, opts?: { dir?: string }): Promise<void>;
  deleteSession(id: string, opts?: { dir?: string }): Promise<void>;
}

export function createRealAdapter(): SdkAdapter {
  return {
    mock: false,
    query: (params) => realSdk.query(params) as unknown as QueryHandle,
    listSessions: (o) => realSdk.listSessions(o),
    getSessionMessages: (id, o) => realSdk.getSessionMessages(id, o),
    renameSession: (id, t, o) => realSdk.renameSession(id, t, o),
    deleteSession: (id, o) => realSdk.deleteSession(id, o),
  };
}

export function createAdapter(mock = process.env.WORKSTATION_MOCK === '1'): SdkAdapter {
  return mock ? createMockAdapter() : createRealAdapter();
}

export type { Query };
