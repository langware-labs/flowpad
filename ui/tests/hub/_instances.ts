/**
 * Realm-per-instance harness: bring up a real, bootstrapped SDK client per named
 * instance (dev-1, dev-2, …) in ONE process — each in its OWN module realm.
 *
 * "Each instance == its own window": there is no shared `currentSdk` pointer and
 * no `run()` scope. Instead, before importing `@sdk` we point the runtime config
 * at the instance's backend (`globalThis.__FLOWPAD_API_URL__`, honoured by
 * `load_config`) and `vi.resetModules()` so the next `import('@sdk')` re-evaluates
 * the whole graph fresh — its own `dataManager` / `apiClient` / `connectionManager`
 * / `config` singletons, bound to that backend. Two `getInstance` calls give two
 * fully isolated SDK clients whose entity classes (`sdk.Skill`, `sdk.Conversation`)
 * each route to their own backend with no cross-talk.
 *
 * Reads the instance's `.env.<name>.local` (written by
 * `scripts/instance_ctl.sh launch <name>`) for its backend port and hub email.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { vi } from 'vitest';
import { parseDotEnv } from './_hub';

/** The freshly-evaluated `@sdk` module namespace for one realm/instance. */
export type SdkRealm = typeof import('@sdk');

// ui/tests/hub → worktree root (where instance_ctl writes .env.<name>.local).
const WORKTREE_ROOT = path.resolve(__dirname, '../../..');

async function readEnvFile(name: string): Promise<Record<string, string>> {
  try {
    return parseDotEnv(await fs.readFile(path.join(WORKTREE_ROOT, `.env.${name}.local`), 'utf-8'));
  } catch {
    return {};
  }
}

export interface ResolvedInstance {
  name: string;
  apiUrl: string;
  email: string;
  /** This realm's `@sdk` namespace — its singletons + entity classes. */
  sdk: SdkRealm;
}

/** True when `.env.<name>.local` exists with a backend port (i.e. launched). */
export async function instanceAvailable(name: string): Promise<boolean> {
  const env = await readEnvFile(name);
  return !!env.LOCAL_SERVER_PORT;
}

/**
 * Bring up an isolated SDK realm for the named instance and bootstrap it. Throws
 * if it isn't launched (caller should skip, like the hub tests skip when the hub
 * is down).
 */
export async function getInstance(name: string): Promise<ResolvedInstance> {
  const env = await readEnvFile(name);
  const port = env.LOCAL_SERVER_PORT;
  if (!port) {
    throw new Error(
      `instance '${name}' not launched (no .env.${name}.local). Run: scripts/instance_ctl.sh launch ${name}`,
    );
  }
  const apiUrl = `http://localhost:${port}`;
  const email = env.FLOWPAD_CLOUD_USER_EMAIL || `${name}@local.test`;

  // Point the next module realm at this backend, then re-evaluate the SDK graph
  // (resetModules gives this instance its own dataManager/apiClient/ws/config).
  (globalThis as any).__FLOWPAD_API_URL__ = apiUrl;
  vi.resetModules();
  const sdk: SdkRealm = await import('@sdk');

  const bootstrapInfo = await sdk.dataManager.bootstrap('localhost', true);
  await sdk.dataManager.loadTypes(bootstrapInfo.types || []);
  // Best-effort: the skill flow resolves over HTTP; a WS hiccup (e.g. jsdom has
  // no WebSocket) shouldn't fail bootstrap — live updates only.
  try {
    if (!sdk.connectionManager.connected) await sdk.connectionManager.connect();
  } catch {
    /* HTTP still works without the socket */
  }

  return { name, apiUrl, email, sdk };
}

/** Find the pending invitation for `convId` on the receiver's freshly-synced
 *  local DB. `fetchConversations()` is the production hub catch-up (pulls the
 *  conversation + invitation lists from the hub into local SQL); without it
 *  `Invitation.query` only sees stale rows. Prefers an exact conv match; this
 *  hub doesn't always stamp `target_url_path`, so falls back to the NEWEST
 *  unaccepted invite addressed to this instance — the sort is what skips stale
 *  invitations left in the persistent instance DB. Mirrors `matrix.bob`. */
export async function findPendingInvitation(inst: ResolvedInstance, convId: string): Promise<any> {
  await inst.sdk.fetchConversations();
  const all: any[] = await (inst.sdk.Invitation as any).query({ query: {} }, true);
  const exact = all.find((inv) => !inv.accepted && (inv.target_url_path || '').includes(convId));
  if (exact) return exact;
  const mine = all
    .filter((inv) => !inv.accepted && inv.recipient_email === inst.email)
    .sort((a, b) => String(b.created_date ?? '').localeCompare(String(a.created_date ?? '')));
  return mine[0] ?? null;
}
