/**
 * Hub REST helpers for Playwright bindings that talk to the hub as a named
 * identity. The hub URL is the caller's (`QA_HUB_URL`) — no fallback here.
 */
import { expect, type APIRequestContext } from '@playwright/test';

export async function hubLogin(
  rq: APIRequestContext,
  hub: string,
  email: string,
  pw: string,
): Promise<{ token: string; id: string }> {
  const res = await rq.post(`${hub}/api/v1/login`, { data: { email, password: pw } });
  expect(res.status(), `hub login ${email}`).toBe(200);
  const d = (await res.json()).data;
  const token = d?.token ?? d?.api_key;
  expect(token, `token for ${email}`).toBeTruthy();
  return { token, id: d.user.id };
}

/** Request options carrying a bearer token, for the hub's JSON routes. */
export function auth(token: string) {
  return { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
}
