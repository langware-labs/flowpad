/**
 * `resolveNextTabPure` — the headless default-tab pick over backend Tabs,
 * routed through the single `resolveActive` resolver.
 *
 * Precedence: pending intent (consume-once) → recency (max `last_active_at`) →
 * lowest `tab_order`. Recency lives on the Tab (server-stamped by the `activate`
 * action on select), so the previously-active tab is the max-recency member.
 *
 * "Pickable" exclusions: not disabled and not in `excludeIds` (by the row's
 * target key `shell-<id>` / `agentic_process-<id>` or its bare target id),
 * filtered BEFORE resolving so an excluded tab can never win any tier.
 */
import { describe, expect, it } from 'vitest';
import { Tab } from '@sdk';
import { resolveNextTabPure, tabTargetKey } from '@sdk/tabs';
import { uid } from '../utils/terminal-tab-fixtures';

let tabIdCounter = 0;

function nextTabId(): string {
  tabIdCounter += 1;
  return `10000000-0000-4000-8000-${String(tabIdCounter).padStart(12, '0')}`;
}

function row(
  name: string,
  opts: { type?: string; tabOrder?: number; lastActiveAt?: number | null; disabled?: boolean } = {},
): Tab {
  const target_type = opts.type ?? 'shell';
  const target_id = uid(name);
  const tab = new Tab({
    id: nextTabId(),
    pointer: `shell|${target_type}-${target_id}`,
    target_type,
    target_id,
    visible: true,
  });
  Object.assign(tab, {
    project_id: null,
    name,
    icon_key: null,
    worktree: false,
    tab_order: opts.tabOrder ?? 0,
    last_active_at: opts.lastActiveAt ?? null,
    status: null,
    is_disabled: opts.disabled ?? false,
  });
  return tab;
}

function resolve(
  tabs: readonly Tab[],
  excludeIds: ReadonlySet<string> = new Set(),
  pendingIntentKey: string | null = null,
): ReturnType<typeof resolveNextTabPure> {
  return resolveNextTabPure({ tabs, excludeIds, pendingIntentKey });
}

describe('resolveNextTabPure — resolveActive precedence', () => {
  it('picks the lowest tab_order when there is no intent and no recency', () => {
    const rows = [row('b', { tabOrder: 2 }), row('a', { tabOrder: 1 })];
    expect(resolve(rows).tab?.name).toBe('a');
  });

  it('prefers the most-recently-active tab over tab_order', () => {
    const rows = [row('a', { lastActiveAt: 1_000, tabOrder: 0 }), row('b', { lastActiveAt: 2_000, tabOrder: 5 })];
    expect(resolve(rows).tab?.name).toBe('b');
  });

  it('the last-activated tab wins via recency (replaces the old previous-target tier)', () => {
    const rows = [row('a', { lastActiveAt: 1_000 }), row('prev', { lastActiveAt: 9_999_999 })];
    expect(resolve(rows).tab?.name).toBe('prev');
  });

  it('an explicit pending intent wins over recency and is consumed', () => {
    const a = row('a', { lastActiveAt: 9_999_999 });
    const b = row('b', { tabOrder: 9 });
    const result = resolve([a, b], new Set(), tabTargetKey(b));
    expect(result.tab?.name).toBe('b');
    expect(result.consumedPendingIntent).toBe(true);
  });

  it('an intent for a non-member is ignored and NOT consumed', () => {
    const rows = [row('a', { tabOrder: 1 })];
    const result = resolve(rows, new Set(), `shell-${uid('elsewhere')}`);
    expect(result.tab?.name).toBe('a');
    expect(result.consumedPendingIntent).toBe(false);
  });

  it('an intent for an EXCLUDED tab cannot win (candidates filtered first) and is not consumed', () => {
    const a = row('a', { tabOrder: 1 });
    const b = row('b', { tabOrder: 2 });
    const result = resolve([a, b], new Set([uid('a')]), tabTargetKey(a));
    expect(result.tab?.name).toBe('b');
    expect(result.consumedPendingIntent).toBe(false);
  });
});

describe('resolveNextTabPure — pickability exclusions', () => {
  it('skips disabled tabs', () => {
    const rows = [row('a', { disabled: true }), row('b', { tabOrder: 1 })];
    expect(resolve(rows).tab?.name).toBe('b');
  });

  it('skips tabs whose target id is excluded', () => {
    const rows = [row('a'), row('b', { tabOrder: 1 })];
    expect(resolve(rows, new Set([uid('a')])).tab?.name).toBe('b');
  });

  it('skips a process tab whose process id (its target id) is excluded', () => {
    const rows = [row('p1', { type: 'agentic_process' }), row('b', { tabOrder: 1 })];
    expect(resolve(rows, new Set([uid('p1')])).tab?.name).toBe('b');
  });

  it('skips a tab excluded by its target key (shell-<id> / agentic_process-<id>)', () => {
    const a = row('a');
    const rows = [a, row('b', { tabOrder: 1 })];
    expect(resolve(rows, new Set([tabTargetKey(a)])).tab?.name).toBe('b');
  });

  it('returns null when nothing is pickable', () => {
    expect(resolve([row('a', { disabled: true })]).tab).toBeNull();
    expect(resolve([]).tab).toBeNull();
  });

  it('skips tabs with no target id', () => {
    const missing = row('missing');
    missing.target_id = null;
    expect(resolve([missing, row('pickable', { tabOrder: 1 })]).tab?.name).toBe('pickable');
  });
});

describe('resolveNextTabPure — project scope', () => {
  it('confines selection to an exact project when the preference is present', () => {
    const projectA = row('a', { lastActiveAt: 1 });
    projectA.project_id = 'project-a';
    const projectB = row('b', { lastActiveAt: 999 });
    projectB.project_id = 'project-b';

    const result = resolveNextTabPure({ tabs: [projectA, projectB], preferProjectId: 'project-a' });
    expect(result.tab).toBe(projectA);
  });

  it('treats explicit null as Global scope while omission remains global selection', () => {
    const project = row('project', { lastActiveAt: 999 });
    project.project_id = 'project-a';
    const global = row('global', { lastActiveAt: 1 });

    expect(resolveNextTabPure({ tabs: [project, global], preferProjectId: null }).tab).toBe(global);
    expect(resolveNextTabPure({ tabs: [project, global] }).tab).toBe(project);
  });
});

describe('stale legacy-display intent', () => {
  it('a pending intent keyed to a reaped display row falls through without crashing', () => {
    // Legacy display rows are reaped server-side (one tab per process); a
    // stored intent naming `display|agentic_process-<id>` can never match a
    // live row again — the resolver must fall through to recency/tab_order.
    const rows = [row('b', { tabOrder: 2, lastActiveAt: 5 }), row('a', { tabOrder: 1 })];
    const result = resolve(rows, new Set(), `display|agentic_process-${uid('gone')}`);
    expect(result.tab?.name).toBe('b');
    expect(result.consumedPendingIntent).toBe(false);
  });
});
