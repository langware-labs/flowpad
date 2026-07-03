/**
 * A2 pinning test — `AgenticProcess.spawn(..., { headless: true })` must persist
 * `pty_mode: false` on the created entity.
 *
 * `pty_mode` is the *transport* axis (PTY worker vs headless one-subprocess-per-turn
 * JSON stream). The route loader attaches a PTY only when `pty_mode !== false`, so a
 * headless spawn that forgot to stamp `pty_mode=false` would leave the default
 * (`true`) on disk and the loader would wrongly PTY-attach a headless session.
 *
 * Real entity + real backend (apiTestSetup). A headless spawn WITHOUT an
 * instruction only creates + watches the entity (no worker launch), so this stays
 * fast and driver-free — we assert the persisted transport intent, not a live turn.
 *
 * Fails pre-fix: the create payload omitted `pty_mode`, so the reloaded row read
 * back the field default (`true`).
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
