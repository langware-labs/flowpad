/**
 * Realm-per-instance harness: boot one isolated SDK realm per explicitly named
 * instance. Hub tests write real data, so an env file alone is not proof that
 * an instance is safe to use: the generated env, launcher registry, canonical
 * hub/identity contract, and both launcher PIDs must all agree first.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { createSdkRealm } from '../_sdk_realm';
import { HUB_URL, parseDotEnv, syncAssignedConversationAt } from './_hub';

/** The freshly-evaluated `@sdk` module namespace for one realm/instance. */
export type SdkRealm = typeof import('@sdk');

// ui/tests/hub -> worktree root (where instance_ctl writes .env.<name>.local).
export const WORKTREE_ROOT = path.resolve(__dirname, '../../..');

/** Canonical two-client identities. There are deliberately no named defaults. */
export const HUB_INST_1 = process.env.SHARE_INST_1?.trim() || '';
export const HUB_INST_2 = process.env.SHARE_INST_2?.trim() || '';

/** Read a generated instance env synchronously ({} if absent or unsafe). */
function readEnvFileSync(name: string): Record<string, string> {
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return {};
  try {
    return parseDotEnv(readFileSync(path.join(WORKTREE_ROOT, `.env.${name}.local`), 'utf-8'));
  } catch {
    return {};
  }
}

/** Public file-reader shape retained for browser/CLI helpers that await it. */
export function readEnvFile(name: string): Promise<Record<string, string>> {
  return Promise.resolve(readEnvFileSync(name));
}

interface LauncherRegistry {
  name?: unknown;
  frontend_port?: unknown;
  backend_port?: unknown;
  hub_url?: unknown;
  email?: unknown;
  env_file?: unknown;
  backend_pid?: unknown;
  frontend_pid?: unknown;
}

export interface LaunchedInstance {
  name: string;
  apiUrl: string;
  email: string;
  env: Record<string, string>;
}

function normalizeUrl(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\/$/, '') : '';
}

function pidIsLive(value: unknown): boolean {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function canonicalIdentity(name: string): { email: string; password: string } | null {
  const pair =
    name === HUB_INST_1
      ? { email: process.env.ALICE_EMAIL?.trim() || '', password: process.env.ALICE_PW || '' }
      : name === HUB_INST_2
        ? { email: process.env.BOB_EMAIL?.trim() || '', password: process.env.BOB_PW || '' }
        : null;
  return pair?.email && pair.password ? pair : null;
}

/**
 * Resolve a launcher-owned instance synchronously. No launch, network probe,
 * retry, poll, or wait occurs here; a stale/mismatched identity fails closed.
 */
export function resolveLaunchedInstance(name: string): LaunchedInstance | null {
  const identity = canonicalIdentity(name);
  if (!identity || !HUB_URL || HUB_INST_1 === HUB_INST_2) return null;

  const env = readEnvFileSync(name);
  const backendPort = env.LOCAL_SERVER_PORT;
  const frontendPort = env.VITE_PORT;
  if (
    env.FLOW_INSTANCE !== name ||
    !/^\d+$/.test(backendPort || '') ||
    !/^\d+$/.test(frontendPort || '') ||
    env.VITE_API_URL !== `http://localhost:${backendPort}` ||
    normalizeUrl(env.FLOWPAD_HUB_URL) !== HUB_URL ||
    env.FLOWPAD_CLOUD_USER_EMAIL !== identity.email ||
    env.FLOWPAD_CLOUD_USER_PASSWORD !== identity.password
  ) {
    return null;
  }

  const flowHome = path.resolve(process.env.FLOW_HOME || path.join(homedir(), '.flow'));
  let launcher: LauncherRegistry;
  try {
    launcher = JSON.parse(
      readFileSync(path.join(flowHome, 'instances', name, 'launcher.json'), 'utf-8'),
    ) as LauncherRegistry;
  } catch {
    return null;
  }

  const expectedEnvFile = path.join(WORKTREE_ROOT, `.env.${name}.local`);
  const launcherEnvFile = typeof launcher.env_file === 'string' ? path.resolve(launcher.env_file) : '';
  if (
    launcher.name !== name ||
    Number(launcher.backend_port) !== Number(backendPort) ||
    Number(launcher.frontend_port) !== Number(frontendPort) ||
    normalizeUrl(launcher.hub_url) !== HUB_URL ||
    launcher.email !== identity.email ||
    launcherEnvFile !== expectedEnvFile ||
    !pidIsLive(launcher.backend_pid) ||
    !pidIsLive(launcher.frontend_pid)
  ) {
    return null;
  }

  return {
    name,
    apiUrl: `http://localhost:${backendPort}`,
    email: identity.email,
    env,
  };
}

export interface ResolvedInstance extends LaunchedInstance {
  /** This realm's `@sdk` namespace - its singletons + entity classes. */
  sdk: SdkRealm;
}

/** True only for a canonical, matching, launcher-owned live instance. */
export function instanceAvailable(name: string): boolean {
  return resolveLaunchedInstance(name) !== null;
}

/** Bring up and bootstrap an isolated SDK realm for a validated instance. */
export async function getInstance(name: string): Promise<ResolvedInstance> {
  const launched = resolveLaunchedInstance(name);
  if (!launched) {
    throw new Error(
      `hub instance '${name}' is not a matching live launcher-owned instance ` +
        '(check SHARE_INST_1/2, canonical credentials, generated env, launcher identity, and PIDs)',
    );
  }

  // The helper scopes the runtime override to module evaluation and owns the
  // realm's socket until hub/_setup.ts disposes all realms from this file.
  const { sdk } = await createSdkRealm(launched.apiUrl);

  const bootstrapInfo = await sdk.dataManager.bootstrap('localhost', true);
  await sdk.dataManager.loadTypes(bootstrapInfo.types || []);
  // HTTP remains authoritative when the test DOM has no usable WebSocket.
  try {
    if (!sdk.connectionManager.connected) await sdk.connectionManager.connect();
  } catch {
    /* HTTP still works without the socket */
  }

  return { ...launched, sdk };
}

/** Raw POST to an instance's /api/v1 — the production HTTP surface the tests
 *  drive for actions the SDK doesn't wrap (add_message with asset_references,
 *  body upload/download, attachment install/uninstall). */
export const postApi = (apiUrl: string, p: string, body?: unknown) =>
  fetch(`${apiUrl}/api/v1${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

/** MessageAttachment rows for a message, invalidated past the realm's query
 *  cache — install/uninstall land as UPDATEs the cached query won't refetch. */
export async function queryMessageAttachments(inst: ResolvedInstance, fmId: string): Promise<any[]> {
  return (await inst.sdk.MessageAttachment.query(
    new inst.sdk.QueryRequest({
      type: 'message_attachment',
      query: { flow_message_id: fmId },
      name: 'message attachments (hub test)',
    }),
    /* invalidate — re-read from the backend, not the realm's query cache */ true,
  ).catch(() => [])) as any[];
}

/** A conversation's FlowMessage rows on one instance, read past the realm's
 *  query cache (a poll that reuses the cached answer never sees the arrival
 *  it is waiting for). */
export async function queryConversationMessages(inst: ResolvedInstance, convId: string): Promise<any[]> {
  return (await inst.sdk.FlowMessage.query(
    new inst.sdk.QueryRequest({ query: { conversation_id: convId }, scope: [] }),
    /* invalidate */ true,
  )) as any[];
}

/** Materialize one immediately assigned conversation on the receiver. */
export async function syncAssignedConversation(inst: ResolvedInstance, convId: string): Promise<unknown> {
  return syncAssignedConversationAt(`${inst.apiUrl}/api/v1`, convId, inst.name);
}
