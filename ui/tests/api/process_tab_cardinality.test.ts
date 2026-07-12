/**
 * One tab per agentic process — API cardinality contract.
 *
 * A process has exactly ONE Tab row (its shell pointer) in both view modes:
 * vibe is a rendering mode carried by `?viewMode`, never a second pointer
 * family. Re-opening the same process — the wire effect of every mode toggle
 * and re-navigation — must reuse the one row (uuid5 get-or-create), and no
 * display-pointer row may ever exist for it.
 *
 * Runs against the running backend (LOCAL_SERVER_PORT). Real entities, real
 * HTTP, no mocks.
 */
import { AgenticProcess, Tab } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

describe('api: process tab cardinality', () => {
  const info = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(info, context.task.name);
  });

  it('repeated opens (mode toggles) reuse ONE shell row; no display rows exist', async () => {
    const id = uuidv4();
    await new AgenticProcess({
      id,
      name: 'cardinality process',
      worker_type: 'claude_code',
    } as any).save();

    const pointer = JSON.stringify({ viewType: 'shell', pointer: `agentic_process-${id}` });
    // Standard open, then the same open again — a vibe toggle changes only the
    // URL's ?viewMode param, so the wire call is byte-identical.
    await Tab.newTab(pointer, { targetType: AgenticProcess.type, targetId: id });
    await Tab.newTab(pointer, { targetType: AgenticProcess.type, targetId: id });

    const all = await Tab.listAll();
    const mine = all.filter((t) => t.target_id === id);
    expect(mine).toHaveLength(1);
    expect(mine[0].dockPointer?.viewType).toBe('shell');
    expect(mine[0].parent_tab_id ?? null).toBeNull();
  }, 15000);
});
