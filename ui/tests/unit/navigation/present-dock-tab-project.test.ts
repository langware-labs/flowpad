/**
 * The seam a `flow show` placement's `project_id` crosses on the client: a raw
 * file no project owns is placed INSIDE the showing process's project, so the
 * mint (`Tab.resolveDockTarget`) stamps that project on the row and the
 * project's strip has a chip to light. Entity-backed assets are rebased onto a
 * project dock; the backend preserves that presentation project on the tab.
 */
import { describe, expect, it } from 'vitest';
import { dockPointerForFile } from '@src/navigation/local-file-pointer';
import { placeDockInProject } from '@src/navigation/present-dock-tab';
import { projectScope } from '@src/lib/scope-filter';

const PROJECT = '2a1e40da-9221-4ea4-82f3-18a0928a4654';
const SNIPPET = '/private/var/folders/t7/x/T/flowpad-snippets/20261013-090944-7c47d1.py';

describe('placeDockInProject', () => {
  it('a raw file is placed in the showing process project', () => {
    const placed = placeDockInProject(dockPointerForFile(SNIPPET), PROJECT);
    expect(placed.scopeFilter).toEqual(projectScope(PROJECT));
    expect(placed.tabHash).toBe(dockPointerForFile(SNIPPET).tabHash);
  });

  it('a global process (no project) leaves the file unscoped', () => {
    expect(placeDockInProject(dockPointerForFile(SNIPPET), null).scopeFilter).toBeNull();
  });
});
