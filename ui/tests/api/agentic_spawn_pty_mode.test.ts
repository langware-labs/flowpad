/**
 * A2 pinning test — `AgenticProcess.spawn(..., { headless: true })` must persist
 * `pty_mode: false` on the created entity.
 *
 * `pty_mode` is the *transport* axis (PTY worker vs headless one-subprocess-per-turn
 * JSON stream). The route loader attaches a PTY only when `pty_mode !== false`, so a
 * create response that omitted `pty_mode=false` would hydrate the legacy default
 * (`true`) and the next save would wrongly persist a PTY transport.
 *
 * Real entity + real backend (apiTestSetup). A headless spawn without a
 * `workerOptions.instruction` only creates + watches the entity (no worker launch),
 * so this stays fast and driver-free — we assert the persisted transport intent,
 * not a live turn.
 *
 * Fails pre-fix: the backend saved `pty_mode=false` but returned an identity-only
 * response; SDK hydration defaulted the omitted field to `true`, and spawn's save
 * could overwrite the durable row.
 */
import { AgenticProcess } from '@sdk';
import { describe, expect, it } from 'vitest';
import { apiTestSetup, trackCreatedRows } from '../utils/test-utils';

const { created, fetchRow } = trackCreatedRows(AgenticProcess.type);

describe('AgenticProcess.spawn headless → pty_mode=false', () => {
  it('headless spawn persists pty_mode=false on the reloaded entity', async () => {
    await apiTestSetup();

    const { process } = await AgenticProcess.spawn(
      { workerType: 'claude_code', instructions: 'stay idle' },
      { headless: true },
    );
    created.push(process.id);

    // In-memory entity already carries the transport intent…
    expect(process.pty_mode).toBe(false);

    // …and it round-trips through the backend (the loader reads the persisted row).
    const row = await fetchRow(process.id);
    expect(row.pty_mode).toBe(false);
  });
});
