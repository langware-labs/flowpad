import {
  parseInterfaceBlock,
} from '@src/components/milkdown-editor/plugins/fence-render/renderers/interface-schema';
import { interfaceRenderer } from '@src/components/milkdown-editor/plugins/fence-render/renderers/interface';
import { describe, expect, it } from 'vitest';

const VALID = `
name: createTask
description: Create a task in the current project.
params:
  title: string
  due: date?
returns: Task
errors: [NotFound, Forbidden]
`;

describe('parseInterfaceBlock', () => {
  it('parses a full spec', () => {
    expect(parseInterfaceBlock(VALID)).toEqual({
      name: 'createTask',
      description: 'Create a task in the current project.',
      params: [
        { name: 'title', type: 'string', optional: false, description: undefined },
        { name: 'due', type: 'date', optional: true, description: undefined },
      ],
      returns: 'Task',
      errors: ['NotFound', 'Forbidden'],
    });
  });

  it('requires only a name', () => {
    const spec = parseInterfaceBlock('name: ping');
    expect(spec).toEqual({
      name: 'ping',
      description: undefined,
      params: [],
      returns: undefined,
      errors: [],
    });
  });

  /*
   * The trailing `?` is the whole optionality notation — it has to survive
   * stray whitespace, and must not eat a type that merely ends in a question
   * mark-ish character.
   */
  it('reads the trailing ? as optional and strips it from the type', () => {
    const spec = parseInterfaceBlock('name: f\nparams:\n  a: "date? "\n  b: "  int?"\n  c: string');
    expect(spec.params).toEqual([
      { name: 'a', type: 'date', optional: true, description: undefined },
      { name: 'b', type: 'int', optional: true, description: undefined },
      { name: 'c', type: 'string', optional: false, description: undefined },
    ]);
  });

  it('treats a lone "?" as a type, not an optional marker', () => {
    const spec = parseInterfaceBlock('name: f\nparams:\n  a: "?"');
    expect(spec.params[0]).toMatchObject({ type: '?', optional: false });
  });

  it('accepts the object form of a param, with a description', () => {
    const spec = parseInterfaceBlock(
      'name: f\nparams:\n  title:\n    type: string?\n    description: The title.',
    );
    expect(spec.params[0]).toEqual({
      name: 'title',
      type: 'string',
      optional: true,
      description: 'The title.',
    });
  });

  it('preserves param declaration order', () => {
    const spec = parseInterfaceBlock('name: f\nparams:\n  zeta: a\n  alpha: b\n  mid: c');
    expect(spec.params.map((p) => p.name)).toEqual(['zeta', 'alpha', 'mid']);
  });
});

describe('parseInterfaceBlock errors', () => {
  it('rejects an empty block', () => {
    expect(() => parseInterfaceBlock('   \n  ')).toThrow(/empty interface block/i);
  });

  it('rejects malformed YAML with the parser message', () => {
    expect(() => parseInterfaceBlock('name: [unclosed')).toThrow(/invalid yaml/i);
  });

  it('rejects a YAML scalar or list at the top level', () => {
    expect(() => parseInterfaceBlock('just a string')).toThrow(/must be a YAML mapping/);
    expect(() => parseInterfaceBlock('- one\n- two')).toThrow(/must be a YAML mapping/);
  });

  /* The error has to name the offending key, or the chip is useless. */
  it('names the missing key when name is absent', () => {
    expect(() => parseInterfaceBlock('returns: Task')).toThrow(/^name:/);
  });

  it('names the offending key when a field has the wrong type', () => {
    expect(() => parseInterfaceBlock('name: f\nerrors: not-a-list')).toThrow(/^errors:/);
    expect(() => parseInterfaceBlock('name: f\nreturns: [a, b]')).toThrow(/^returns:/);
  });

  it('rejects an empty name', () => {
    expect(() => parseInterfaceBlock('name: ""')).toThrow(/name must not be empty/);
  });
});

describe('interface renderer', () => {
  it('renders a signature card into the host', async () => {
    const host = document.createElement('div');
    await interfaceRenderer.render(VALID, host, { theme: 'dark', blockId: 'b1', editable: true, commit: () => {} });

    const card = host.querySelector('[data-testid="interface-card"]');
    expect(card).not.toBeNull();
    expect(card?.querySelector('.interface-card-name')?.textContent).toBe('createTask');
    expect([...card!.querySelectorAll('.interface-card-param-name')].map((n) => n.textContent))
      .toEqual(['title', 'due']);
    // Every param carries the badge — it is a toggle, and `is-off` is its
    // unpressed state. Only `due` is actually optional.
    const badges = [...card!.querySelectorAll('.interface-card-badge')];
    expect(badges.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    expect([...card!.querySelectorAll('.interface-card-chip')].map((n) => n.textContent))
      .toEqual(['NotFound', 'Forbidden']);
    expect(card?.querySelector('.interface-card-returns')?.textContent).toContain('Task');
  });

  it('omits sections that the spec does not declare', async () => {
    const host = document.createElement('div');
    await interfaceRenderer.render('name: ping', host, { theme: 'light', blockId: 'b1', editable: true, commit: () => {} });

    const card = host.querySelector('[data-testid="interface-card"]')!;
    expect(card.querySelector('.interface-card-description')).toBeNull();
    expect(card.querySelector('.interface-card-returns')).toBeNull();
    expect(card.querySelectorAll('.interface-card-param')).toHaveLength(0);
    expect(card.querySelectorAll('.interface-card-chip')).toHaveLength(0);
  });

  /*
   * The renderer contract is throw-based: the NodeView relies on the throw to
   * keep the last good card and show a chip instead of blanking the block.
   */
  it('throws rather than rendering a partial card on bad input', () => {
    const host = document.createElement('div');
    expect(() => interfaceRenderer.render('returns: Task', host, { theme: 'dark', blockId: 'b1', editable: true, commit: () => {} }))
      .toThrow(/^name:/);
    expect(host.children).toHaveLength(0);
  });

  it('claims the `interface` language', () => {
    expect(interfaceRenderer.language).toBe('interface');
    expect(interfaceRenderer.tabLabel).toBe('Interface');
  });
});
