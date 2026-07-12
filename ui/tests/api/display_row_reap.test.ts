/**
 * Legacy display-row reap — API migration contract.
 *
 * The display surface is no longer a Tab identity. An old static FE
 * (mid-upgrade window) can still mint rows whose pointer is
 * `{"viewType":"display",...}` — and children under them; the backend must
 * CONVERGE: no display-pointer row survives a list read, the live target
 * process is never touched (row-only delete), and no child is ever left with
 * a dangling parent edge. (The exact re-anchor-to-shell semantics for rows
 * that PRE-EXIST a reap cycle together are pinned at the pytest tier, where
 * legacy state can be seeded without the wire's ensure-triggered reaps.)
 *
 * Also covers the ensure_tab invariant on the wire: a `new_tab` carrying
 * `parent_tab_id` for a process-target tab stores a null parent.
 *
 * Runs against the running backend. Real entities, real HTTP, no mocks.
 */
import { AgenticProcess, Tab } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

describe('api: legacy display-row reap', () => {
  const info = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(info, context.task.name);
  });

  it('display row is reaped on list; its child re-anchors to the shell tab', async () => {
    const id = uuidv4();
    await new AgenticProcess({
      id,
      name: 'reap process',
      worker_type: 'claude_code',
    } as any).save();

    const shellPointer = JSON.stringify({ viewType: 'shell', pointer: `agentic_process-${id}` });
    const displayPointer = JSON.stringify({ viewType: 'display', pointer: `agentic_process-${id}` });

    const afterShell = await Tab.newTab(shellPointer, {
      targetType: AgenticProcess.type,
      targetId: id,
    });
    const shellTab = afterShell.find((t) => t.target_id === id && t.dockPointer?.viewType === 'shell');
    expect(shellTab).toBeTruthy();

    // Seed the legacy display row + a child under it (what an old FE minted).
    // The row's id is deterministic (uuid5 of the pointer hash) — computed
    // client-side because any list read, including new_tab's own response, may
    // already have reaped the row.
    const displayTabId = uuidv5(`tab:display|agentic_process-${id}`, uuidv5.URL);
    await Tab.newTab(displayPointer, {
      targetType: AgenticProcess.type,
      targetId: id,
    });

    const childTargetId = uuidv4();
    await Tab.newTab(JSON.stringify({ viewType: 'editor', pointer: `markdown-${childTargetId}` }), {
      targetType: 'markdown',
      targetId: childTargetId,
      parentTabId: displayTabId,
    });

    // The next list read converges: display row gone; the child survives with
    // NO dangling edge (re-anchored to the shell tab when both rows coexisted
    // at reap time, else healed to null by the dangling-parent sweep).
    const all = await Tab.listAll();
    const mine = all.filter((t) => t.target_id === id);
    expect(mine.map((t) => t.dockPointer?.viewType)).toEqual(['shell']);

    const child = all.find((t) => t.target_id === childTargetId);
    expect(child, 'child tab must survive the reap').toBeTruthy();
    expect([shellTab!.id, null]).toContain(child!.parent_tab_id ?? null);
    expect(child!.parent_tab_id).not.toBe(displayTabId);

    // And the live process itself was never touched by the row-only delete.
    const proc = await AgenticProcess.getById(id);
    expect(proc).toBeTruthy();
  }, 15000);

  it('new_tab never stores a parent on a process-target tab (wire invariant)', async () => {
    const anchorId = uuidv4();
    await new AgenticProcess({
      id: anchorId,
      name: 'anchor process',
      worker_type: 'claude_code',
    } as any).save();
    const anchorRows = await Tab.newTab(
      JSON.stringify({ viewType: 'shell', pointer: `agentic_process-${anchorId}` }),
      { targetType: AgenticProcess.type, targetId: anchorId },
    );
    const anchor = anchorRows.find((t) => t.target_id === anchorId);
    expect(anchor).toBeTruthy();

    const otherId = uuidv4();
    await new AgenticProcess({
      id: otherId,
      name: 'would-be child process',
      worker_type: 'claude_code',
    } as any).save();
    const rows = await Tab.newTab(
      JSON.stringify({ viewType: 'shell', pointer: `agentic_process-${otherId}` }),
      { targetType: AgenticProcess.type, targetId: otherId, parentTabId: anchor!.id },
    );
    const other = rows.find((t) => t.target_id === otherId);
    expect(other).toBeTruthy();
    expect(other!.parent_tab_id ?? null).toBeNull();
  }, 15000);
});
