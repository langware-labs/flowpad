/**
 * Unified-strip preview semantics (tab-management.md Part 3 §5) + global
 * section (§6):
 *
 *   - the transient chip exists exactly when the current dock matches neither
 *     the terminal surface nor an entity member key
 *   - browsing N docs produces N descriptors for ONE slot and ZERO membership
 *     writes; promotion (`tabs/open`) is the only write and is wired solely to
 *     the explicit "Keep as tab" context-menu action
 *   - global-section partition + localStorage default-ON persistence
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataContext, dataManager, ViewType } from '@sdk';
import { openTabTargets } from '@src/tabs/useTabs';
import {
  dockTargetTypeIdKey,
  partitionEntityRows,
  readShowGlobalSection,
  SHOW_GLOBAL_SECTION_STORAGE_KEY,
  transientForDock,
  writeShowGlobalSection,
} from '@src/tabs/unified-strip-model';
import { uid } from '../utils/terminal-tab-fixtures';

const mdKey = (label: string) => `markdown-${uid(label)}`;
const editorDock = (label: string) => ({
  viewType: ViewType.ASSETS,
  pointer: `editor/markdown/typeid/${mdKey(label)}`,
});

describe('dockTargetTypeIdKey', () => {
  it('resolves the typeid form of the canonical asset-editor pointer', () => {
    expect(dockTargetTypeIdKey(editorDock('doc1'))).toBe(mdKey('doc1'));
  });

  it('resolves project-rebased editor pointers too', () => {
    expect(
      dockTargetTypeIdKey({
        viewType: ViewType.PROJECT,
        pointer: `${uid('proj')}/editor/markdown/typeid/${mdKey('doc1')}`,
      }),
    ).toBe(mdKey('doc1'));
  });

  it('is null for vfs pointers and non-asset docks', () => {
    expect(
      dockTargetTypeIdKey({ viewType: ViewType.ASSETS, pointer: 'editor/markdown/vfs/compute_node-@local/a.md' }),
    ).toBeNull();
    expect(dockTargetTypeIdKey({ viewType: ViewType.SETTINGS })).toBeNull();
    expect(dockTargetTypeIdKey(null)).toBeNull();
  });
});

describe('transient preview slot (§5)', () => {
  const noMembers = { isMemberKey: () => false };

  it('appears for a non-member dock (typeid doc, settings, search)', () => {
    const t = transientForDock(editorDock('doc1'), noMembers);
    expect(t).not.toBeNull();
    expect(t!.promotableTypeIdKey).toBe(mdKey('doc1'));
    expect(transientForDock({ viewType: ViewType.SETTINGS }, noMembers)).not.toBeNull();
    expect(transientForDock({ viewType: ViewType.SEARCH }, noMembers)).not.toBeNull();
  });

  it('does NOT appear for the terminal surface or a member doc or no dock', () => {
    expect(transientForDock({ viewType: ViewType.SHELL, pointer: 'shell-x' }, noMembers)).toBeNull();
    expect(
      transientForDock(editorDock('doc1'), { isMemberKey: (k) => k === mdKey('doc1') }),
    ).toBeNull();
    expect(transientForDock(null, noMembers)).toBeNull();
  });

  it('browsing N docs yields one slot per dock and ZERO membership writes', () => {
    const callActionSpy = vi.spyOn(dataManager, 'callAction');
    const keys = new Set<string>();
    for (const label of ['d1', 'd2', 'd3', 'd4', 'd5']) {
      const t = transientForDock(editorDock(label), noMembers);
      expect(t).not.toBeNull();
      keys.add(t!.key);
      // Always active and never persisted: dismiss/promote are the only verbs.
      expect(t!.promotableTypeIdKey).toBe(mdKey(label));
    }
    expect(keys.size).toBe(5); // descriptor follows the URL, one slot at a time
    expect(callActionSpy).not.toHaveBeenCalled(); // 0 member writes
    callActionSpy.mockRestore();
  });

  it('only the explicit "Keep as tab" action wires the tabs/open promotion', () => {
    // Source contract (same style as terminal-close-all-race): the unified
    // strip calls openTabTargets exactly once, inside the "Keep as tab"
    // context-menu handler — loaders/clicks never become tab-creators.
    const src = readFileSync(
      resolve(__dirname, '../../src/pages/flow-page/content-panel/unified-tab-strip.tsx'),
      'utf-8',
    );
    const calls = src.match(/openTabTargets\(/g) ?? [];
    expect(calls.length).toBe(1);
    const keepAsTabBlock = src.slice(src.indexOf("label: 'Keep as tab'"));
    expect(keepAsTabBlock).toContain('openTabTargets([transient.promotableTypeIdKey!])');
  });
});

describe('tabs/open promotion (one batched POST)', () => {
  let callActionSpy: ReturnType<typeof vi.spyOn>;
  let getContextEntitySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers(); // keep the scheduled membership refetch from firing
    callActionSpy = vi
      .spyOn(dataManager, 'callAction')
      .mockResolvedValue({ accepted: [mdKey('doc1')], missing: [], invalid: [] } as never) as never;
    // dataContext.computeNode is a mobx computed (non-configurable) — stub
    // the underlying context-entity lookup it reads from instead.
    getContextEntitySpy = vi
      .spyOn(dataContext, 'getContextEntity')
      .mockReturnValue({ id: uid('cn') } as never) as never;
  });

  afterEach(() => {
    callActionSpy.mockRestore();
    getContextEntitySpy.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('posts tabs/open once with the promoted typeid', async () => {
    const result = await openTabTargets([mdKey('doc1')]);
    expect(result.accepted).toEqual([mdKey('doc1')]);
    expect(callActionSpy).toHaveBeenCalledTimes(1);
    const action = callActionSpy.mock.calls[0][0] as {
      name: string;
      subpath: string;
      bodyParameters: Record<string, unknown>;
    };
    expect(action.name).toBe('tabs');
    expect(action.subpath).toBe('open');
    expect(action.bodyParameters).toEqual({ targets: [mdKey('doc1')] });
  });
});

describe('global section (§6)', () => {
  const row = (label: string, projectId: string | null) => ({
    kind: 'markdown',
    typeId: null as never,
    key: mdKey(label),
    name: label,
    projectId,
    tabOrder: 0,
    lastActiveAt: null,
  });

  it('partitions rows: strict project filter; null-project rows are global-only', () => {
    const rows = [row('a', uid('p1')), row('b', uid('p2')), row('g', null)];
    const { projectRows, globalRows } = partitionEntityRows(rows, uid('p1'));
    expect(projectRows.map((r) => r.name)).toEqual(['a']);
    expect(globalRows.map((r) => r.name)).toEqual(['g']);
    // No active project: nothing in the project section, no duplication.
    const noProject = partitionEntityRows(rows, null);
    expect(noProject.projectRows).toEqual([]);
    expect(noProject.globalRows.map((r) => r.name)).toEqual(['g']);
  });

  it('localStorage gate defaults ON and round-trips', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(readShowGlobalSection(storage)).toBe(true); // default ON
    writeShowGlobalSection(false, storage);
    expect(store.get(SHOW_GLOBAL_SECTION_STORAGE_KEY)).toBe('false');
    expect(readShowGlobalSection(storage)).toBe(false);
    writeShowGlobalSection(true, storage);
    expect(readShowGlobalSection(storage)).toBe(true);
  });
});
