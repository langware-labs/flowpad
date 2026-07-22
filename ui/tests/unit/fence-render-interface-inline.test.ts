/**
 * Inline editing on the interface card.
 *
 * Covers the card → `commit` path: which gestures commit, which don't, and
 * that what gets committed is YAML the parser accepts back.
 */

import { renderInterfaceCard } from '@src/components/milkdown-editor/plugins/fence-render/renderers/interface';
import { parseInterfaceBlock } from '@src/components/milkdown-editor/plugins/fence-render/renderers/interface-schema';
import type { FenceRenderContext } from '@src/components/milkdown-editor/plugins/fence-render/registry';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SOURCE = `name: createTask
description: Create a task.
params:
  title: string
  due: date?
returns: Task
errors: [NotFound, Forbidden]
`;

let host: HTMLElement;
let commit: ReturnType<typeof vi.fn>;
let ctx: FenceRenderContext;

beforeEach(() => {
  host = document.createElement('div');
  document.body.replaceChildren(host);
  commit = vi.fn();
  ctx = { theme: 'dark', blockId: 'b1', editable: true, host: { openFile: () => {}, documentProjectRoot: () => null, projectRootById: () => null }, commit };
  renderInterfaceCard(SOURCE, host, ctx);
});

function field(testId: string): HTMLElement {
  const node = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!node) throw new Error(`no field ${testId}`);
  return node;
}

/** Type into a contenteditable field and blur, which is what commits. */
function type(testId: string, text: string): void {
  const node = field(testId);
  node.textContent = text;
  node.dispatchEvent(new FocusEvent('blur'));
}

function key(testId: string, k: string): void {
  field(testId).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

/** The YAML handed to the last commit. */
function committed(): string {
  expect(commit).toHaveBeenCalled();
  return commit.mock.calls.at(-1)![0] as string;
}

describe('inline editing commits', () => {
  it('commits a renamed interface', () => {
    type('interface-name', 'makeTask');
    expect(parseInterfaceBlock(committed()).name).toBe('makeTask');
  });

  it('commits an edited description', () => {
    type('interface-description', 'Creates it.');
    expect(parseInterfaceBlock(committed()).description).toBe('Creates it.');
  });

  it('commits an edited return type', () => {
    type('interface-returns', 'TaskId');
    expect(parseInterfaceBlock(committed()).returns).toBe('TaskId');
  });

  it('commits a renamed param', () => {
    type('interface-param-name-title', 'heading');
    expect(parseInterfaceBlock(committed()).params.map((p) => p.name)).toEqual(['heading', 'due']);
  });

  it('commits an edited param type without losing its optional marker', () => {
    type('interface-param-type-due', 'timestamp');
    expect(parseInterfaceBlock(committed()).params[1]).toMatchObject({
      type: 'timestamp',
      optional: true,
    });
  });

  it('commits an edited error name', () => {
    type('interface-error-0', 'Missing');
    expect(parseInterfaceBlock(committed()).errors).toEqual(['Missing', 'Forbidden']);
  });

  it('toggles optional on from the badge', () => {
    field('interface-param-optional-title').click();
    expect(parseInterfaceBlock(committed()).params[0]).toMatchObject({ optional: true });
  });

  it('toggles optional off from the badge', () => {
    field('interface-param-optional-due').click();
    expect(parseInterfaceBlock(committed()).params[1]).toMatchObject({ optional: false });
  });
});

describe('inline editing does not commit', () => {
  it('when the value is unchanged', () => {
    type('interface-name', 'createTask');
    expect(commit).not.toHaveBeenCalled();
  });

  it('when only surrounding whitespace changed', () => {
    type('interface-name', '  createTask  ');
    expect(commit).not.toHaveBeenCalled();
    // …and the stray whitespace is cleaned out of the DOM.
    expect(field('interface-name').textContent).toBe('createTask');
  });

  /*
   * An emptied field would delete the key from the YAML entirely. Treat it as a
   * slip and restore, rather than silently dropping the author's data.
   */
  it('when the field is emptied — it reverts instead', () => {
    type('interface-name', '');
    expect(commit).not.toHaveBeenCalled();
    expect(field('interface-name').textContent).toBe('createTask');
  });

  it('when the edit is cancelled with Escape', () => {
    const node = field('interface-name');
    node.textContent = 'throwaway';
    key('interface-name', 'Escape');
    expect(node.textContent).toBe('createTask');
    node.dispatchEvent(new FocusEvent('blur'));
    expect(commit).not.toHaveBeenCalled();
  });
});

describe('inline editing sequences', () => {
  /*
   * The card redraws itself against the committed source after every edit. If
   * it didn't, a second edit would be computed against the ORIGINAL YAML and
   * would silently revert the first.
   */
  it('applies two edits cumulatively rather than reverting the first', () => {
    type('interface-name', 'makeTask');
    type('interface-returns', 'TaskId');

    const spec = parseInterfaceBlock(committed());
    expect(spec.name).toBe('makeTask');
    expect(spec.returns).toBe('TaskId');
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('reflects a badge toggle in the redrawn card', () => {
    field('interface-param-optional-title').click();
    expect(field('interface-param-optional-title').getAttribute('aria-pressed')).toBe('true');

    field('interface-param-optional-title').click();
    expect(field('interface-param-optional-title').getAttribute('aria-pressed')).toBe('false');
    expect(parseInterfaceBlock(committed()).params[0]).toMatchObject({ optional: false });
  });

  it('keeps the rest of the spec intact across an edit', () => {
    type('interface-param-name-title', 'heading');
    const spec = parseInterfaceBlock(committed());
    expect(spec).toMatchObject({
      name: 'createTask',
      description: 'Create a task.',
      returns: 'Task',
      errors: ['NotFound', 'Forbidden'],
    });
    expect(spec.params[1]).toMatchObject({ name: 'due', type: 'date', optional: true });
  });

  it('lets a renamed param be edited again under its new name', () => {
    type('interface-param-name-title', 'heading');
    type('interface-param-type-heading', 'text');

    const spec = parseInterfaceBlock(committed());
    expect(spec.params[0]).toMatchObject({ name: 'heading', type: 'text' });
  });
});

/*
 * The card's controls live in a `contenteditable="false"` pane, outside
 * ProseMirror's own editable check — so nothing but this gate stops a user
 * editing a document they are only meant to be reading. That is not
 * hypothetical: the vibe display renders assets read-only, and before this
 * gate existed an inline edit there wrote straight through to disk.
 */
describe('read-only host', () => {
  let ro: HTMLElement;
  let roCommit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ro = document.createElement('div');
    roCommit = vi.fn();
    renderInterfaceCard(SOURCE, ro, {
      theme: 'dark',
      blockId: 'b1',
      editable: false,
      host: { openFile: () => {}, documentProjectRoot: () => null, projectRootById: () => null },
      commit: roCommit,
    });
  });

  function roField(testId: string): HTMLElement | null {
    return ro.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }

  it('still renders the card and all its values', () => {
    expect(ro.querySelector('[data-testid="interface-card"]')).not.toBeNull();
    expect(roField('interface-name')?.textContent).toBe('createTask');
    expect(roField('interface-returns')?.textContent).toBe('Task');
    expect([...ro.querySelectorAll('.interface-card-param-name')].map((n) => n.textContent))
      .toEqual(['title', 'due']);
  });

  it('exposes no contenteditable fields', () => {
    expect(ro.querySelectorAll('[contenteditable="true"]')).toHaveLength(0);
    expect(roField('interface-name')?.getAttribute('role')).toBeNull();
  });

  it('does not commit when a value field is blurred', () => {
    const name = roField('interface-name')!;
    name.textContent = 'tampered';
    name.dispatchEvent(new FocusEvent('blur'));
    expect(roCommit).not.toHaveBeenCalled();
  });

  it('renders no toggle button, and no badge for a required param', () => {
    expect(ro.querySelector('button')).toBeNull();
    // `title` is required — with no toggle to show, the badge is just noise.
    expect(roField('interface-param-optional-title')).toBeNull();
    // `due` is optional, so the badge stays as signal.
    expect(roField('interface-param-optional-due')?.textContent).toBe('optional');
  });

  it('does not commit when the optional badge is clicked', () => {
    roField('interface-param-optional-due')?.click();
    expect(roCommit).not.toHaveBeenCalled();
  });
});

describe('editable field wiring', () => {
  it('marks value fields as editable text boxes', () => {
    for (const id of ['interface-name', 'interface-returns', 'interface-param-type-title']) {
      expect(field(id).getAttribute('contenteditable')).toBe('true');
      expect(field(id).getAttribute('role')).toBe('textbox');
    }
  });

  it('does not render controls for fields the author did not write', () => {
    const bare = document.createElement('div');
    renderInterfaceCard('name: ping\n', bare, ctx);
    expect(bare.querySelector('[data-testid="interface-description"]')).toBeNull();
    expect(bare.querySelector('[data-testid="interface-returns"]')).toBeNull();
  });
});
