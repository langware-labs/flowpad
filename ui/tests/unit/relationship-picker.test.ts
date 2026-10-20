// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mountRelationshipPicker } from '../../../ts_sdk/src/viewers/relationship';
import { createViewerContext } from '../../../ts_sdk/src/viewers/registry';
import type { RelationshipQuery } from '../../../ts_sdk/src/viewers/contract';

const rows = [
  { key: 'one', label: 'One', value: 'kind.id.one', parent: 'a' },
  { key: 'two', label: 'Two', value: 'kind.id.two', parent: 'a' },
  { key: 'three', label: 'Three', value: 'kind.id.three', parent: 'b' },
];
async function candidates(query: RelationshipQuery) {
  const matches = rows.filter(row => row.parent === query.parent.group && row.label.toLowerCase().includes(query.search.toLowerCase()));
  const offset = Number(query.cursor ?? 0);
  return { items: matches.slice(offset, offset + 1), next: offset + 1 < matches.length ? String(offset + 1) : undefined };
}
const context = () => createViewerContext({ candidates });

describe('relationship picker', () => {
  it('filters parents, searches/pages, and preserves ordered reference values', async () => {
    const el = document.createElement('div');
    let group = 'a';
    const picker = mountRelationshipPicker(el, { kind: 'kind', field: 'members', multiple: true,
      parent: () => ({ group }), selected: [rows[1]] }, context());
    await picker.refresh();
    const select = el.querySelector('select')!;
    expect([...select.options].map(o => o.value)).toEqual(['', 'one']);
    select.value = 'one'; select.dispatchEvent(new Event('change'));
    expect(picker.read()).toEqual(['kind.id.two', 'kind.id.one']);
    el.querySelector<HTMLButtonElement>('[aria-label="Move One up"]')!.click();
    expect(picker.read()).toEqual(['kind.id.one', 'kind.id.two']);
    await picker.refresh(true);
    expect(picker.read()).toEqual(['kind.id.one', 'kind.id.two']);
    group = 'b'; await picker.refresh();
    expect([...select.options].map(o => o.value)).toEqual(['', 'three']);
    el.querySelector('input')!.value = 'absent'; await picker.refresh();
    expect(el.textContent).toContain('No matches');
    expect(picker.read()).toEqual(['kind.id.one', 'kind.id.two']);
  });

  it('does not let an old parent response overwrite newer candidates', async () => {
    const pending: ((page: { items: typeof rows }) => void)[] = [];
    const ctx = createViewerContext({ candidates: () => new Promise(resolve => pending.push(resolve)) });
    const el = document.createElement('div');
    const picker = mountRelationshipPicker(el, { kind: 'kind', field: 'member', parent: () => ({}) }, ctx);
    const first = picker.refresh(); const second = picker.refresh();
    expect(() => picker.validate()).toThrow('loading');
    pending[1]({ items: [rows[2]] }); await second;
    pending[0]({ items: [rows[0]] }); await first;
    expect([...el.querySelector('select')!.options].map(o => o.value)).toEqual(['', 'three']);
    expect(() => picker.validate()).not.toThrow();
  });

  it('retains owned values without querying or allowing changes', async () => {
    const el = document.createElement('div');
    const picker = mountRelationshipPicker(el, { kind: 'kind', field: 'owner', readonly: true,
      parent: () => ({}), selected: [rows[0]] }, context());
    await picker.refresh();
    expect(el.querySelector('select')!.disabled).toBe(true);
    expect(el.querySelector('[aria-label="Remove One"]')).toBeNull();
    expect(picker.read()).toBe('kind.id.one');
  });
});
