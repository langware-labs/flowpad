import type { RelationshipCandidate, ViewerContext } from './contract';

export interface RelationshipPickerOptions {
  kind: string;
  field: string;
  parent: () => Record<string, unknown>;
  selected?: RelationshipCandidate[];
  multiple?: boolean;
  readonly?: boolean;
  onChange?: () => void;
}

/** Edit references without resolving them into embedded records. Existing selections survive
 * search/pages and parent changes; Dataset remains the authority on valid links and writes. */
export function mountRelationshipPicker(el: HTMLElement, options: RelationshipPickerOptions, ctx: ViewerContext) {
  if (!ctx.candidates) throw new Error('This host has no relationship candidate provider.');
  const provider = ctx.candidates;
  const { h } = ctx;
  let selected = [...(options.selected ?? [])];
  let items: RelationshipCandidate[] = [];
  let next: string | undefined;
  let generation = 0;
  let pending = false;
  let failure: unknown;
  const search = h('input', { type: 'search', 'aria-label': `Search ${options.field}`, disabled: options.readonly }) as HTMLInputElement;
  const picks = h('div');
  const select = h('select', { 'aria-label': options.field, disabled: options.readonly }) as HTMLSelectElement;
  const status = h('span', { role: 'status' });
  const more = h('button', { type: 'button', hidden: true }, 'More') as HTMLButtonElement;
  el.replaceChildren(search, picks, select, more, status);

  function changed() { draw(); options.onChange?.(); }
  function draw() {
    picks.replaceChildren(...selected.map((item, index) => h('div', {}, item.label,
      options.multiple && !options.readonly ? h('button', {
        type: 'button', 'aria-label': `Move ${item.label} up`, disabled: index === 0,
        onclick: () => { [selected[index - 1], selected[index]] = [selected[index], selected[index - 1]]; changed(); },
      }, '↑') : null,
      !options.readonly ? h('button', { type: 'button', 'aria-label': `Remove ${item.label}`,
        onclick: () => { selected = selected.filter(x => x.key !== item.key); changed(); } }, '×') : null)));
    const selectedKeys = new Set(selected.map(item => item.key));
    select.replaceChildren(h('option', { value: '' }, 'Choose…'),
      ...items.filter(item => !selectedKeys.has(item.key)).map(item => h('option', { value: item.key }, item.label)));
    select.disabled = !!options.readonly || pending;
    more.hidden = !next || !!options.readonly;
    more.disabled = pending;
  }
  async function refresh(append = false): Promise<void> {
    if (options.readonly) return;
    const ticket = ++generation;
    pending = true; failure = undefined; status.textContent = 'Loading…'; draw();
    try {
      const page = await provider({ kind: options.kind, field: options.field, parent: options.parent(),
        selected: [...selected], search: search.value, cursor: append ? next : undefined });
      if (ticket !== generation) return;
      const unique = new Map((append ? items : []).map(item => [item.key, item]));
      page.items.forEach(item => unique.set(item.key, item));
      items = [...unique.values()]; next = page.next;
      status.textContent = items.length ? '' : 'No matches';
    } catch (error) {
      if (ticket !== generation) return;
      failure = error; status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      if (ticket === generation) { pending = false; draw(); }
    }
  }
  select.addEventListener('change', event => {
    // The host's onChange owns dependency refresh; do not also bubble a second change.
    event.stopPropagation();
    const item = items.find(x => x.key === select.value);
    if (item) { selected = options.multiple ? [...selected, item] : [item]; changed(); }
  });
  search.addEventListener('input', () => { void refresh(); });
  more.addEventListener('click', () => { void refresh(true); });
  draw();
  return {
    refresh,
    read: () => options.multiple ? selected.map(item => item.value) : selected[0]?.value ?? null,
    /** Hosts use this gate before saving; reading is still safe during dependency refresh. */
    validate: () => { if (pending) throw new Error('Relationship choices are loading.'); if (failure) throw failure; },
  };
}
