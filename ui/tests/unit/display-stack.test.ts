/**
 * The display history's two pure decisions, extracted from the toolbar so they can
 * be stated directly rather than inferred from a render.
 */
import { describe, expect, it } from 'vitest';
import type { DisplayEntry } from '@sdk';
import { displayHistory, historyEntryDock, projectIdFromDock } from '@src/pages/flow-page/display-stack';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const PROJ = 'dd682350-c185-52c9-a92b-d0667141b069';
const A = { kind: 'vfs', path: '/w/a.md', shown_at: '2026-01-01T00:00:00.000Z' } as DisplayEntry;
const B = { kind: 'vfs', path: '/w/b.md', shown_at: '2026-01-01T00:01:00.000Z' } as DisplayEntry;

describe('displayHistory', () => {
  it('passes the server stack through when nothing newer is known', () => {
    expect(displayHistory([A, B], null)).toEqual([A, B]);
    expect(displayHistory([], undefined)).toEqual([]);
  });

  it('appends the newest show when the server stack has not caught up', () => {
    // The gap this closes: the stack rides the entity-update broadcast, which can
    // land while a show's navigation is rebuilding the workspace subscription.
    expect(displayHistory([A], B)).toEqual([A, B]);
  });

  it('does not double-count a show the server already has', () => {
    expect(displayHistory([A, B], B)).toEqual([A, B]);
  });

  it('appends at most ONE, so it can never grow a parallel history', () => {
    // Bounded on purpose: the next authoritative read supersedes it, rather than a
    // local mirror accumulating and drifting from the server's `shown_at` ordering.
    const once = displayHistory([A], B);
    expect(displayHistory(once, B)).toHaveLength(2);
  });

  it('distinguishes targets by the key their kind actually uses', () => {
    const port3000 = { kind: 'webapp', port: 3000 } as DisplayEntry;
    const port3001 = { kind: 'webapp', port: 3001 } as DisplayEntry;
    expect(displayHistory([port3000], port3001)).toHaveLength(2);
    expect(displayHistory([port3000], port3000)).toHaveLength(1);

    const appX = { kind: 'app', artifact_id: 'x' } as DisplayEntry;
    const appY = { kind: 'app', artifact_id: 'y' } as DisplayEntry;
    expect(displayHistory([appX], appY)).toHaveLength(2);
    expect(displayHistory([appX], appX)).toHaveLength(1);
  });
});

describe('historyEntryDock', () => {
  it('opens a past display WITHOUT the active-display marker', () => {
    // That omission is the behavior: no marker means ordinary tab identity, so the
    // row becomes a durable tab instead of re-pointing the agent's replaceable one.
    const dock = historyEntryDock({ kind: 'vfs', path: '/w/a.md' }, PROJ);
    expect(dock).not.toBeNull();
    expect(dock!.isActiveDisplay).toBe(false);
  });

  it('rebases an assets-shaped dock onto the project', () => {
    // A bare ASSETS dock is scope-keyed — every sub-pointer folds into one tab — so
    // an un-rebased document would hijack that scope's Assets tab.
    const dock = historyEntryDock(
      { kind: 'entity', type: 'markdown', typeid: 'markdown-6ba7b810-9dad-41d1-80b4-00c04fd430c8' },
      PROJ,
    );
    expect(dock?.viewType).toBe(ViewType.PROJECT);
    expect(dock?.pointer?.startsWith(PROJ)).toBe(true);
  });

  it('answers null for a target that addresses nothing openable', () => {
    expect(historyEntryDock({ kind: 'entity', type: 'dataset', typeid: 'dataset-x' }, PROJ)).toBeNull();
  });
});

describe('projectIdFromDock', () => {
  it('reads the project a hosted dock is rebased onto', () => {
    expect(projectIdFromDock(new DockPointer(ViewType.PROJECT, `${PROJ}/editor/markdown/typeid/markdown-x`))).toBe(PROJ);
  });

  it('is null when there is no dock', () => {
    expect(projectIdFromDock(null)).toBeNull();
  });
});
