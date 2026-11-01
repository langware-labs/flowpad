/**
 * Tier 2 @long — Spora, tenant stubbed. Skeleton (phase 10 fills it).
 *
 * Setup: `git clone --depth 1 --filter=blob:none` of Spora's origin into the instance workspace
 * (never copy `~/Flowpad workspace/sapora-streams`, 3.7 GB); a committed mini bundle stands in for
 * `flutter build web` (same `fetch(SPORA_BOOTSTRAP_URL/api/bootstrap)` + `Uncaught`);
 * `fixtures/spora/stub_tenant.py` on :8300 returns the public bootstrap shape
 * (`platform/tenant/spec.py public()`), declared as a webapp service; the `asset_setup`
 * dependency node points at it.
 */
import { test } from '@playwright/test';

test.describe('tier 2 — Spora stubbed @long', () => {
  for (const app of ['Spora App', 'Spora Back Office']) {
    test.fixme(`${app}: S1–S7 run fully against the stub tenant`, async () => {
      // S1 cold open → app selector; S2 warm return 0 calls / < 200 ms; S3 backend restart stays UP;
      // S4 dev server SIGKILL → up→degraded→starting→up, 0 agents; S5 tenant killed → dependency node
      // shown, setup(<node>) ran, UP, 0 agents; S6 known error handled; S7 unknown error → 1 agent.
    });
  }
  test.fixme('Spora Admin: runs to "setup owed: credential:google-cloud, needs_person, no agent"', async () => {});
  test.fixme('Spora Assistant: home tile → /dock/vibe/…, auto_open display resolves, nothing owed, 0 fixer runs', async () => {});
});
