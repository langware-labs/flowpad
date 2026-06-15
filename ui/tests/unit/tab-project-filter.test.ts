/**
 * Source-contract: locks that the Tab-sourced terminal strip
 * (`buildTerminalRows` in useTabs.ts) filters STRICTLY by project id and does
 * NOT re-introduce the removed "orphan include" rule (`|| projectId == null`).
 * The strict filter is what makes a project's strip project-scoped.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(resolve(__dirname, '../../src/tabs/useTabs.ts'), 'utf-8');

describe('terminal strip — strict project filter', () => {
  it('filters by exact projectId equality', () => {
    expect(src).toContain('rows.filter((r) => r.projectId === projectId)');
  });

  it('does NOT include null-project orphans (the removed orphan-include rule)', () => {
    expect(src).not.toContain('r.projectId === projectId || r.projectId == null');
    expect(src).not.toContain('(r) => r.projectId == null');
  });
});
