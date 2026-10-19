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

  it('N shows produce ONE active-display row that re-points, not N chips', async () => {
    // The wire proof of the replaceable display. Each `flow show` writes a pointer
    // whose TARGET differs but whose `tabHash` is the hosting workspace, so the
    // backend must reconcile them onto a single row and rewrite it in place —
    // otherwise a chatty agent buries the user under a chip per show.
    const id = uuidv4();
    await new AgenticProcess({ id, name: 'display cardinality', worker_type: 'claude_code' } as any).save();
    const shellPointer = JSON.stringify({ viewType: 'shell', pointer: `agentic_process-${id}` });
    const anchor = await Tab.newTab(shellPointer, { targetType: AgenticProcess.type, targetId: id });
    const anchorId = anchor.find((t) => t.target_id === id)?.id ?? null;

    // A raw `editor` pointer rather than a project-rebased one: a pointer naming a
    // project that does not exist is reaped on the list read (correctly), and this
    // test is about cardinality, not project resolution.
    const tabHash = `workspaceActive|agentic_process-${id}`;
    const targetIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const markdownId = uuidv4();
      targetIds.push(markdownId);
      await Tab.newTab(
        JSON.stringify({
          viewType: 'editor',
          pointer: `/workspace/docs/doc-${markdownId}.md`,
          options: { activeDisplay: '1' },
          tabHash,
          workspaceContent: true,
        }),
        { targetType: 'markdown', targetId: markdownId, name: `doc-${i}`, parentTabId: anchorId },
      );
    }

    const all = await Tab.listAll();
    const displays = all.filter((t) => (t.pointer ?? '').includes(tabHash));
    expect(displays).toHaveLength(1);
    // It points at the LAST show, and its label followed — the backfill-only rule
    // is deliberately relaxed for this one namespace.
    expect(displays[0].pointer).toContain(targetIds[targetIds.length - 1]);
    expect(displays[0].name).toBe('doc-9');
    // Still exactly one row for the process itself, still a top-level anchor.
    const processRows = all.filter((t) => t.target_id === id);
    expect(processRows).toHaveLength(1);
    expect(processRows[0].parent_tab_id ?? null).toBeNull();
  }, 25000);

});
