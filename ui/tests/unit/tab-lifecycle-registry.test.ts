import { describe, expect, it, vi } from 'vitest';
import { Tab } from '@sdk';
import { TabLifecycleRegistry, TabLifecycleState, tabKey } from '@sdk/tabs';

let tabIdCounter = 0;

function nextTabId(): string {
  tabIdCounter += 1;
  return `40000000-0000-4000-8000-${String(tabIdCounter).padStart(12, '0')}`;
}

function tab(label: string, pointer?: string): Tab {
  const id = nextTabId();
  return new Tab({
    id,
    pointer: pointer ?? JSON.stringify({ viewType: 'shell', pointer: `shell-${label}` }),
    target_type: 'shell',
    target_id: id,
    visible: true,
  });
}

describe('TabLifecycleRegistry', () => {
  it('normalizes errors, retains tab id, and publishes a stable snapshot between writes', () => {
    const registry = new TabLifecycleRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const initial = registry.getSnapshot();

    registry.set('dock', TabLifecycleState.Opening, { tabId: 'tab-id' });
    const opening = registry.getSnapshot();
    expect(opening).not.toBe(initial);
    expect(registry.getSnapshot()).toBe(opening);

    registry.set('dock', TabLifecycleState.OpenFailed, { error: new Error('attach failed') });
    expect(registry.get('dock')).toMatchObject({ tabId: 'tab-id', error: 'attach failed' });
    registry.set('dock', TabLifecycleState.CloseFailed, { error: 'close failed' });
    expect(registry.get('dock')?.error).toBe('close failed');
    registry.set('dock', TabLifecycleState.OpenFailed, { error: { reason: 'unknown' } });
    expect(registry.get('dock')?.error).toBe('Tab content failed to load.');
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('filters only Closing tabs and preserves input identity when none are closing', () => {
    const registry = new TabLifecycleRegistry();
    const closing = tab('closing');
    const opened = tab('opened');
    const failed = tab('failed');
    registry.set(tabKey(closing), TabLifecycleState.Closing);
    registry.set(tabKey(opened), TabLifecycleState.Opened);
    registry.set(tabKey(failed), TabLifecycleState.CloseFailed);

    expect(registry.excludeClosing([closing, opened, failed])).toEqual([opened, failed]);
    const untouched = [opened, failed];
    expect(registry.excludeClosing(untouched)).toBe(untouched);
  });

  it('falls back to tab id for keyless rows', () => {
    const registry = new TabLifecycleRegistry();
    const bare = tab('bare', '');
    registry.set(bare.id, TabLifecycleState.Closing);

    expect(tabKey(bare)).toBe(bare.id);
    expect(registry.getForTab(bare)?.state).toBe(TabLifecycleState.Closing);
    expect(registry.excludeClosing([bare])).toEqual([]);
  });

  it('reconciles id-backed entries by id and key-only entries by key', () => {
    const registry = new TabLifecycleRegistry();
    const original = tab('same-id');
    const originalKey = tabKey(original);
    const keyOnly = tab('key-only');
    registry.set(originalKey, TabLifecycleState.Opened, { tabId: original.id });
    registry.set(tabKey(keyOnly), TabLifecycleState.OpenFailed, { error: 'failed' });

    original.pointer = JSON.stringify({ viewType: 'shell', pointer: 'shell-new-key' });
    registry.reconcile([original, keyOnly]);
    expect(registry.get(originalKey)).not.toBeNull();
    expect(registry.get(tabKey(keyOnly))).not.toBeNull();

    registry.reconcile([]);
    expect(registry.get(originalKey)).toBeNull();
    expect(registry.get(tabKey(keyOnly))).toBeNull();
  });
});
