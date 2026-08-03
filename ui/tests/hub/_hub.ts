/**
 * Shared scaffolding for vitest hub tests — mirrors
 * ``tests/hub_tests/conftest.py`` on the Python side.
 *
 *  - ``hubAvailable``     — quick ``/api/v1/health/status`` probe; tests skip
 *    when the local hub is not running.
 *  - ``ensureLocalLoggedIn`` — verifies the local backend already holds cloud
 *    credentials. We don't try to log in from the test (interactive flow);
 *    the test skips with a clear message if credentials are absent.
 *  - ``getAliceCreds`` / ``getBobCreds`` — read the cycle-owned identities
 *    explicitly supplied by the runner and exchange them for hub bearer tokens.
 */
// No hardcoded hub URL — it must come from the environment (FLOWPAD_HUB_URL),
// the same source the backend/config uses. When unset, HUB_URL is empty and
// ``hubAvailable()`` skips the suite with a clear reason rather than silently
// probing a guessed localhost port.
export const HUB_URL = (process.env.FLOWPAD_HUB_URL ?? '').replace(/\/$/, '');

export async function hubAvailable(): Promise<{ ok: boolean; reason?: string }> {
  if (!HUB_URL) {
    return { ok: false, reason: 'FLOWPAD_HUB_URL is not set — export it to run hub tests' };
  }
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
 *  matching pair of surrounding quotes). Used only for generated named-instance
 *  env files by `_instances.ts`; hub credentials come from the process env. */
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

export function getAliceCreds(): Promise<{ email: string; password: string } | null> {
  const email = process.env.ALICE_EMAIL?.trim();
  const password = process.env.ALICE_PW;
  return Promise.resolve(email && password ? { email, password } : null);
}

export function getBobCreds(): Promise<{ email: string; password: string } | null> {
  const email = process.env.BOB_EMAIL?.trim();
  const password = process.env.BOB_PW;
  return Promise.resolve(email && password ? { email, password } : null);
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

/** Materialize one immediately assigned conversation through a local backend.
 * Callers supply that backend's `/api/v1` base so paired tests cannot drift to
 * a different instance. */
export async function syncAssignedConversationAt<T = unknown>(
  apiV1Base: string,
  convId: string,
  instanceName?: string,
): Promise<T | undefined> {
  const response = await fetch(`${apiV1Base}/graph/conversation-message-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: convId }),
  });
  const body = (await response.json().catch(() => null)) as {
    status?: string;
    data?: T;
  } | null;
  if (!response.ok || body?.status !== 'SUCCESS') {
    const location = instanceName ? ` on ${instanceName}` : '';
    throw new Error(
      `conversation sync failed${location}: HTTP ${response.status} ${JSON.stringify(body)}`,
    );
  }
  return body.data;
}
