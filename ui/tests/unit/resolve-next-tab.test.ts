/**
 * `resolveNextTabRow` (tab-candidates.ts) — the loader-side default-tab pick over
 * backend `TabRow`s, routed through the single `resolveActive` resolver.
 *
 * Precedence: pending intent (consume-once) → recency (max `last_active_at`) →
 * lowest `tab_order`. Recency lives on the Tab (server-stamped by the `activate`
 * action on select), so the previously-active tab is the max-recency member.
 *
 * "Pickable" exclusions: not disabled and not in `excludeIds` (by the row's
 * target key `shell-<id>` / `agentic_process-<id>` or its bare target id),
 * filtered BEFORE resolving so an excluded tab can never win any tier.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TabRow } from '@sdk';
import { resolveNextTabRow, rowTargetKey } from '@src/tabs/tab-candidates';
import { peekPendingIntent, setPendingIntent } from '@src/tabs/pending-intent';
import { uid } from '../utils/terminal-tab-fixtures';

beforeEach(() => setPendingIntent(null));
afterEach(() => setPendingIntent(null));

function row(
  name: string,
  opts: { type?: string; tabOrder?: number; lastActiveAt?: number | null; disabled?: boolean } = {},
): TabRow {
  const target_type = opts.type ?? 'shell';
  const target_id = uid(name);
  return {
    id: `tab-${name}`,
    pointer: `shell|${target_type}-${target_id}`,
    target_type,
    target_id,
    project_id: null,
    name,
    icon_key: null,
    worktree: false,
    tab_order: opts.tabOrder ?? 0,
    last_active_at: opts.lastActiveAt ?? null,
    status: null,
    is_disabled: opts.disabled ?? false,
  };
}

describe('resolveNextTabRow — resolveActive precedence', () => {
  it('picks the lowest tab_order when there is no intent and no recency', () => {
    const rows = [row('b', { tabOrder: 2 }), row('a', { tabOrder: 1 })];
    expect(resolveNextTabRow(rows)?.name).toBe('a');
  });

  it('prefers the most-recently-active tab over tab_order', () => {
    const rows = [row('a', { lastActiveAt: 1_000, tabOrder: 0 }), row('b', { lastActiveAt: 2_000, tabOrder: 5 })];
    expect(resolveNextTabRow(rows)?.name).toBe('b');
  });

  it('the last-activated tab wins via recency (replaces the old previous-target tier)', () => {
    const rows = [row('a', { lastActiveAt: 1_000 }), row('prev', { lastActiveAt: 9_999_999 })];
    expect(resolveNextTabRow(rows)?.name).toBe('prev');
  });

  it('an explicit pending intent wins over recency and is consumed', () => {
    const a = row('a', { lastActiveAt: 9_999_999 });
    const b = row('b', { tabOrder: 9 });
    setPendingIntent(rowTargetKey(b));
    expect(resolveNextTabRow([a, b])?.name).toBe('b');
    expect(peekPendingIntent()).toBeNull(); // consumed — decided the pick
  });

  it('an intent for a non-member is ignored and NOT consumed', () => {
    const rows = [row('a', { tabOrder: 1 })];
    setPendingIntent(`shell-${uid('elsewhere')}`);
    expect(resolveNextTabRow(rows)?.name).toBe('a');
    expect(peekPendingIntent()).toBe(`shell-${uid('elsewhere')}`);
  });

  it('an intent for an EXCLUDED tab cannot win (candidates filtered first) and is not consumed', () => {
    const a = row('a', { tabOrder: 1 });
    const b = row('b', { tabOrder: 2 });
    setPendingIntent(rowTargetKey(a));
    expect(resolveNextTabRow([a, b], new Set([uid('a')]))?.name).toBe('b');
    expect(peekPendingIntent()).toBe(rowTargetKey(a));
  });
});

describe('resolveNextTabRow — pickability exclusions', () => {
  it('skips disabled tabs', () => {
    const rows = [row('a', { disabled: true }), row('b', { tabOrder: 1 })];
    expect(resolveNextTabRow(rows)?.name).toBe('b');
  });

  it('skips tabs whose target id is excluded', () => {
    const rows = [row('a'), row('b', { tabOrder: 1 })];
    expect(resolveNextTabRow(rows, new Set([uid('a')]))?.name).toBe('b');
  });

  it('skips a process tab whose process id (its target id) is excluded', () => {
    const rows = [row('p1', { type: 'agentic_process' }), row('b', { tabOrder: 1 })];
    expect(resolveNextTabRow(rows, new Set([uid('p1')]))?.name).toBe('b');
  });

  it('skips a tab excluded by its target key (shell-<id> / agentic_process-<id>)', () => {
    const a = row('a');
    const rows = [a, row('b', { tabOrder: 1 })];
    expect(resolveNextTabRow(rows, new Set([rowTargetKey(a)]))?.name).toBe('b');
  });

  it('returns null when nothing is pickable', () => {
    expect(resolveNextTabRow([row('a', { disabled: true })])).toBeNull();
    expect(resolveNextTabRow([])).toBeNull();
  });
});
