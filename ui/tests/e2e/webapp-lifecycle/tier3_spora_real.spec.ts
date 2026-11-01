/**
 * Tier 3 @long — real Spora. Skeleton (phase 10 fills it). Never in CI.
 *
 * Gated: runs only with WL_TIER3=1 AND a `tiers-1-2.pass` marker in the report dir. Same scenarios
 * as tier 2, with the dependency node pointing at spora-admin's real `api`; `flutter build web` is
 * measured, not waited for. Credentials only through `flow credentials check google-cloud --project …`
 * — missing → skip, never fail. Includes the screenshot case: Spora App with the tenant down shows the
 * dependency node and starts it through spora-admin's `api`, no agent.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@playwright/test';
import { reportDir } from './_reportdir';

const gated = process.env.WL_TIER3 === '1' && existsSync(join(reportDir(), 'tiers-1-2.pass'));

test.describe('tier 3 — Spora real @long', () => {
  test.skip(!gated, 'tier 3 needs WL_TIER3=1 and tiers-1-2.pass in WL_REPORT_DIR');
  for (const app of ['Spora App', 'Spora Back Office', 'Spora Admin']) {
    test.fixme(`${app}: S1–S7 against real Spora`, async () => {});
  }
  test.fixme('Spora App, tenant down: dependency node starts spora-admin api, no agent, no seen-loop', async () => {});
});
