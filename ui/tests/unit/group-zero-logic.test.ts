import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

// Source-contract test pinning the layer borders of the generic groups FE
// (docs/entities-groups.md): folder mechanics live in the backend, the SDK
// owns all frontend logic, the adapter/menu/hook only render and delegate.
const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf-8');

const adapterSource = read('../../src/components/browseable-tree/adapters/groupRoot.tsx');
const menuSource = read('../../src/components/ui/browseable-menu.tsx');
const hookSource = read('../../src/hooks/useGroupTreeRefresh.ts');
const sdkGroupSource = read('../../../ts_sdk/src/entities/group.ts');

describe('entities-groups frontend is zero-logic', () => {
  it('adapter delegates every mutation to the SDK (no fetch, no direct writes)', () => {
    expect(adapterSource).not.toMatch(/fetch\(|apiClient|axios/);
    // membership/folder mechanics are one-line SDK delegations
    for (const call of ['Group.create', '.rename(', '.deleteGroup(', '.move(', '.setGroup(']) {
      expect(adapterSource).toContain(call);
    }
    // never writes group_id locally — the backend round-trip owns state
    expect(adapterSource).not.toMatch(/\.group_id\s*=/);
  });

  it('adapter listings come from the SDK, not local queries', () => {
    expect(adapterSource).toContain('Group.listRoot');
    expect(adapterSource).toContain('.listChildren(');
    expect(adapterSource).not.toMatch(/QueryRequest|ExpressionNode/);
  });

  it('menu is a pure popover embedding of BrowseableTree', () => {
    expect(menuSource).toContain('BrowseableTree');
    expect(menuSource).not.toMatch(/fetch\(|apiClient|dataManager/);
  });

  it('hook is reactivity-only (subscribe -> refreshNode, no decisions)', () => {
    expect(hookSource).toContain('refreshNode');
    expect(hookSource).toContain('watchQuery');
    expect(hookSource).not.toMatch(/setGroup|create|delete|rename|move\(/);
  });

  it('the listings/queries live in the SDK (IS_NULL roots + EQ children)', () => {
    expect(sdkGroupSource).toContain("'$IS_NULL'");
    expect(sdkGroupSource).toContain('group_namespace');
    expect(sdkGroupSource).toContain('listChildren');
  });
});
