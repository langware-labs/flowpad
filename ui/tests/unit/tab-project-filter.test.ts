/**
 * Phase-0 characterization (source-contract, like terminal-tab-switch.test.ts):
 * locks that `useProjectTerminals` filters the strip STRICTLY by project id and
 * does NOT re-introduce the removed "orphan include" rule (`|| t.projectId ==
 * null`). The strict filter is what makes a project's strip project-scoped — and
 * is the membership side of the round-trip bug the TabManager refactor fixes.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

// The store lives in src/tabs/useTabs.ts (the useActiveTerminals.ts shim
// was deleted at cutover end); the contract assertions read the real source.
const src = readFileSync(resolve(__dirname, '../../src/tabs/useTabs.ts'), 'utf-8');

describe('useProjectTerminals — strict project filter', () => {
  it('filters by exact projectId equality', () => {
    expect(src).toContain('all.data.filter((t) => t.projectId === pid)');
  });

  it('does NOT include null-project orphans (the removed orphan-include rule)', () => {
    // The removed rule was a `|| t.projectId == null` clause INSIDE the filter
    // callback. (A comment in the source legitimately mentions the phrase to
    // document its removal, so we assert on the full filter-callback form.)
    expect(src).not.toContain('t.projectId === pid || t.projectId == null');
    expect(src).not.toContain('(t) => t.projectId == null');
  });
});
