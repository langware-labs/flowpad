/**
 * Sniffer is OPT-IN, default OFF (FLOWPAD).
 * Source: heartbeat_sniffer_hook_events_e2e.md
 *
 * Asserts the shipped default-off contract: bootstrap is reachable (200) and
 * data.sniffer_hook is null (the per-instance sniffer gate is off, so no hook
 * is installed and no sniffer/heartbeat hook events flow). Pure API — no
 * browser. API base from _shared/api (QA_API_URL/API_URL override, else the
 * app's own backend).
 */
import { test, expect } from '@playwright/test';
import { apiBase, apiContext } from '../_shared/api';

const API = apiBase();

test('test 1: Backend is reachable (bootstrap heartbeat)', async () => {
  const api = await apiContext();
  const res = await api.get(`${API}/api/v1/graph/bootstrap`);
  expect(res.status()).toBe(200);
  await api.dispose();
});

test('test 2: No sniffer hook events by default (default-off)', async () => {
  const api = await apiContext();
  const body = await (await api.get(`${API}/api/v1/graph/bootstrap`)).json();
  // sniffer gate off → no hook installed → data.sniffer_hook is null.
  expect(body?.data?.sniffer_hook ?? null).toBeNull();
  await api.dispose();
});
