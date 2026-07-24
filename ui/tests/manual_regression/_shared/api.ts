/**
 * Backend access for manual-regression tests — never hardcode a port.
 *
 * Resolve the same explicit backend origin that Vite injects into the app.
 * Named instances set VITE_API_URL and disable Vite's `/api` proxy, so browser
 * requests must not rely on relative URLs. QA_API_URL / API_URL remain the
 * highest-precedence test overrides.
 */
import { request as pwRequest, type APIRequestContext } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';

const workingDirectory = process.cwd();
const REPO_ROOT = existsSync(path.resolve(workingDirectory, 'ui/package.json'))
  ? workingDirectory
  : path.resolve(workingDirectory, '..');
const FILE_ENV_BY_MODE = new Map<string, Record<string, string>>();

function configuredFileEnv(): Record<string, string> {
  const mode = process.env.FLOW_INSTANCE || 'development';
  const cached = FILE_ENV_BY_MODE.get(mode);
  if (cached) return cached;

  const fileEnv: Record<string, string> = {};
  for (const name of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
    const envPath = path.resolve(REPO_ROOT, name);
    if (existsSync(envPath)) Object.assign(fileEnv, parse(readFileSync(envPath)));
  }
  FILE_ENV_BY_MODE.set(mode, fileEnv);
  return fileEnv;
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Explicit test override, or the backend configured for this app instance. */
export function apiOrigin(): string {
  const fileEnv = configuredFileEnv();
  const explicitUrl =
    process.env.QA_API_URL ||
    process.env.API_URL ||
    process.env.VITE_API_URL ||
    fileEnv.QA_API_URL ||
    fileEnv.API_URL ||
    fileEnv.VITE_API_URL;
  if (explicitUrl) return withoutTrailingSlash(explicitUrl);
  return `http://localhost:${process.env.LOCAL_SERVER_PORT || fileEnv.LOCAL_SERVER_PORT || '9007'}`;
}

/** Absolute prefix for fixture requests and browser-side fetch calls. */
export function apiBase(): string {
  return apiOrigin();
}

/** Node-side APIRequestContext bound to the right backend (see apiOrigin). */
export function apiContext(): Promise<APIRequestContext> {
  return pwRequest.newContext({ baseURL: apiOrigin() });
}
