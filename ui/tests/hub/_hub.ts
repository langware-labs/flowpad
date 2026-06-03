/**
 * Shared scaffolding for vitest hub tests — mirrors
 * ``tests/hub_tests/conftest.py`` on the Python side.
 *
 *  - ``hubAvailable``     — quick ``/api/v1/health/status`` probe; tests skip
 *    when the local hub is not running.
 *  - ``ensureLocalLoggedIn`` — verifies the local backend already holds cloud
 *    credentials. We don't try to log in from the test (interactive flow);
 *    the test skips with a clear message if credentials are absent.
 *  - ``readEnvLocal`` / ``hubLogin`` — load credentials from the OSS + APP
 *    sibling repos' ``.env.local`` files and exchange them for hub bearer
 *    tokens. Used by ``conversation_messages.test.ts`` to simulate a second
 *    identity (bob) sending into alice's shared conversation.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export const HUB_URL =
  process.env.FLOWPAD_HUB_URL?.replace(/\/$/, '') || 'http://localhost:8093';

const REPO_OSS = path.resolve(__dirname, '../../..');
const REPO_APP = path.resolve(REPO_OSS, '..', 'flowpad-app');

export async function hubAvailable(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await fetch(`${HUB_URL}/api/v1/health/status`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) return { ok: false, reason: `hub /health returned ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `hub unreachable at ${HUB_URL}: ${String(e)}` };
  }
}

/** Parse dotenv text into a key→value map (skips comments/blanks, strips a
 *  matching pair of surrounding quotes). Shared by `readEnvLocal` and the
 *  per-instance harness in `_instances.ts`. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

export async function readEnvLocal(repo: string): Promise<Record<string, string>> {
  try {
    return parseDotEnv(await fs.readFile(path.join(repo, '.env.local'), 'utf-8'));
  } catch {
    return {};
  }
}

export interface HubLoginResult {
  token: string;
  user: { id: string; name?: string; email?: string };
}

export async function hubLogin(email: string, password: string): Promise<HubLoginResult> {
  const r = await fetch(`${HUB_URL}/api/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`hub login failed (${r.status}): ${await r.text()}`);
  const body = (await r.json()) as { data: { api_key?: string; token?: string; user?: any } };
  const token = body.data.api_key || body.data.token;
  if (!token) throw new Error(`hub login: no token in response: ${JSON.stringify(body)}`);
  return { token, user: body.data.user ?? {} };
}

/** Read a shared conversation's title straight from the hub (authenticated GET).
 *  Used by the reflection-proxy tests to verify a reflected rename landed on the
 *  hub, independent of any backend↔backend fan-out. Returns null on non-200. */
export async function hubConversationTitle(token: string, convId: string): Promise<string | null> {
  const r = await fetch(`${HUB_URL}/api/v1/graph/conversation/${convId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const body = (await r.json()) as { data?: { title?: string } };
  return body.data?.title ?? null;
}

/** Read the hub's watcher list for a conversation (the GET side of the `watch`
 *  action — its `ConnectedThrough` peers). Non-empty once a backend has
 *  registered a hub watch (e.g. via BrowserContextWatch). Returns null on
 *  non-200, else the (possibly empty) list. */
export async function hubConversationWatchers(token: string, convId: string): Promise<unknown[] | null> {
  const r = await fetch(`${HUB_URL}/api/v1/graph/conversation/${convId}/watch`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const body = (await r.json()) as { data?: unknown[] };
  return Array.isArray(body.data) ? body.data : null;
}

export async function getAliceCreds() {
  const env = await readEnvLocal(REPO_OSS);
  const email = env.FLOWPAD_CLOUD_USER_EMAIL;
  const password = env.FLOWPAD_CLOUD_USER_PASSWORD;
  if (!email || !password) return null;
  return { email, password };
}

export async function getBobCreds() {
  const env = await readEnvLocal(REPO_APP);
  const email = env.FLOWPAD_CLOUD_USER_EMAIL;
  const password = env.FLOWPAD_CLOUD_USER_PASSWORD;
  if (!email || !password) return null;
  return { email, password };
}

/**
 * Verify the LOCAL backend (the one vitest is talking to via ``apiTestSetup``)
 * already holds cloud credentials. We probe ``/api/v1/cloud/status`` — if it
 * 404s or reports not-logged-in, the calling test should skip with a clear
 * message. Cloud login is an interactive flow that lives outside the test
 * harness.
 */
export async function localBackendIsCloudLoggedIn(localApiBase: string): Promise<boolean> {
  try {
    const r = await fetch(`${localApiBase}/cloud/status`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const body = (await r.json()) as { data?: { logged_in?: boolean } };
    return body.data?.logged_in === true;
  } catch {
    return false;
  }
}
