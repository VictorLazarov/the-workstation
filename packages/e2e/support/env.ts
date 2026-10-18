/**
 * Shared test environment. Playwright loads playwright.config.ts once in the runner and again in every
 * worker process; the state is created once and handed down through E2E_STATE so all of them agree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOKEN = 'e2e-fixed-token-0123456789abcdef';
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export interface E2EState {
  home: string;
  project: string;
  mainUrl: string;
  slowUrl: string;
  mainHome: string;
  slowHome: string;
  webSnapshot: string;
  /** third mock server with WORKSTATION_MOCK_FS=1 (Edit/Write touch the disk, Always allow persists) and its own throwaway repo */
  fsUrl: string;
  fsHome: string;
  fsProject: string;
}

export function readState(): E2EState {
  const raw = process.env.E2E_STATE;
  if (!raw) throw new Error('E2E_STATE missing: run tests through playwright.config.ts');
  return JSON.parse(raw) as E2EState;
}

