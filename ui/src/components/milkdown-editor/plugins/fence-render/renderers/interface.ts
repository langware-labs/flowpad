/**
 * ```interface fences render as an inline-editable signature card.
 *
 * Every value the author wrote is click-to-edit, and the optional badge is a
 * toggle. A committed edit rewrites the block's YAML through
 * `applyInterfaceEdit` (which mutates the author's document in place rather
 * than regenerating it), so switching to the Code tab shows the edit already
 * applied, with comments and formatting intact.
 *
 * Structure — adding or removing params and errors — is deliberately not
 * editable here; that happens in the Code tab.
 *
 * Plain DOM, no React root: one root per fence, mounted and unmounted by a
 * ProseMirror NodeView, is a lifecycle hazard for a card this static.
 */

import { registerFenceRenderer, type FenceRenderContext, type FenceRenderer } from '../registry';
import { applyInterfaceEdit, type InterfaceEdit } from './interface-edit';
import { parseInterfaceBlock, type InterfaceParam, type InterfaceSpec } from './interface-schema';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * A click-to-edit value.
 *
 * `contenteditable` on a descendant of the (non-editable) preview pane creates
 * an editable island the host editor ignores — the NodeView's `stopEvent` and
 * `ignoreMutation` keep ProseMirror out of this subtree entirely, so typing
 * here never reaches the outer document.
 *
 * Enter commits, Escape reverts, blur commits. An edit that doesn't change
 * anything commits nothing.
 */
function editable(
  className: string,
  value: string,
  testId: string,
  canEdit: boolean,
  onCommit: (next: string) => void,
): HTMLElement {
  // Read-only host (the vibe display, any `view` mode asset): draw the value as
  // plain text. The controls sit in a `contenteditable="false"` pane, outside
  // ProseMirror's own editable check, so nothing else would stop a user from
  // editing a document they are only meant to be reading.
  if (!canEdit) {
    const readonly = el('span', className, value);
    readonly.setAttribute('data-testid', testId);
    return readonly;
  }

  const node = el('span', `${className} interface-card-editable`, value);
  // setAttribute, not the `contentEditable` IDL property: the property does not
  // reflect to the attribute in jsdom, so component tests could not observe it.
  node.setAttribute('contenteditable', 'true');
  node.spellcheck = false;
  node.setAttribute('role', 'textbox');
  node.setAttribute('data-testid', testId);

  const revert = () => {
    node.textContent = value;
  };

  const commit = () => {
    const next = (node.textContent ?? '').trim();
    if (!next) {
      // An emptied field would delete the key from the YAML; treat it as a
      // mistake and restore rather than silently dropping the author's data.
      revert();
      return;
    }
    if (next === value) {
      node.textContent = value; // normalize away stray whitespace
      return;
    }
    onCommit(next);
  };

  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      node.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      revert();
      node.blur();
    }
  });
  node.addEventListener('blur', commit);

  return node;
}

function paramRow(
  param: InterfaceParam,
  canEdit: boolean,
  edit: (change: InterfaceEdit) => void,
): HTMLElement {
  const row = el('div', 'interface-card-param');

  row.appendChild(
    editable('interface-card-param-name', param.name, `interface-param-name-${param.name}`, canEdit, (value) =>
      edit({ kind: 'param-name', param: param.name, value }),
    ),
  );
  row.appendChild(
    editable('interface-card-param-type', param.type, `interface-param-type-${param.name}`, canEdit, (value) =>
      edit({ kind: 'param-type', param: param.name, value }),
    ),
  );

  // Read-only: the badge is pure signal, so show it only when the param really
  // is optional. A dimmed "off" badge only makes sense as a toggle.
  if (canEdit || param.optional) {
    const badge = canEdit
      ? el('button', 'interface-card-badge', 'optional')
      : el('span', 'interface-card-badge', 'optional');
    badge.setAttribute('data-testid', `interface-param-optional-${param.name}`);
    badge.setAttribute('aria-pressed', String(param.optional));
    badge.classList.toggle('is-off', !param.optional);
    if (canEdit) {
      (badge as HTMLButtonElement).type = 'button';
      badge.title = param.optional ? 'Make required' : 'Make optional';
      badge.addEventListener('click', () => {
        edit({ kind: 'param-optional', param: param.name, optional: !param.optional });
      });
    }
    row.appendChild(badge);
  }

  if (param.description) {
    row.appendChild(el('span', 'interface-card-param-desc', param.description));
  }
  return row;
}

function buildCard(
  spec: InterfaceSpec,
  canEdit: boolean,
  edit: (change: InterfaceEdit) => void,
): HTMLElement {
  const card = el('div', 'interface-card');
  card.setAttribute('data-testid', 'interface-card');

  const header = el('div', 'interface-card-header');
  header.appendChild(
    editable('interface-card-name', spec.name, 'interface-name', canEdit, (value) =>
      edit({ kind: 'name', value }),
    ),
  );
  card.appendChild(header);

  if (spec.description != null) {
    const description = editable(
      'interface-card-description',
      spec.description,
      'interface-description',
      canEdit,
      (value) => edit({ kind: 'description', value }),
    );
    card.appendChild(description);
  }

  if (spec.params.length) {
    const section = el('div', 'interface-card-section');
    section.appendChild(el('div', 'interface-card-label', 'Parameters'));
    for (const param of spec.params) section.appendChild(paramRow(param, canEdit, edit));
    card.appendChild(section);
  }

  if (spec.returns != null) {
    const returns = el('div', 'interface-card-returns');
    returns.appendChild(el('span', 'interface-card-arrow', '→'));
    returns.appendChild(
      editable('interface-card-param-type', spec.returns, 'interface-returns', canEdit, (value) =>
        edit({ kind: 'returns', value }),
      ),
    );
    card.appendChild(returns);
  }

  if (spec.errors.length) {
    const section = el('div', 'interface-card-section');
    section.appendChild(el('div', 'interface-card-label', 'Errors'));
    const chips = el('div', 'interface-card-errors');
    spec.errors.forEach((name, index) => {
      chips.appendChild(
        editable('interface-card-chip', name, `interface-error-${index}`, canEdit, (value) =>
          edit({ kind: 'error', index, value }),
        ),
      );
    });
    section.appendChild(chips);
    card.appendChild(section);
  }

  return card;
}

/**
 * Draw the card for `source`, wiring each control to commit an edit and then
 * redraw against the *new* source.
 *
 * The redraw is required, not cosmetic. The host deliberately suppresses the
 * re-render its own commit would trigger, so that focus inside an inline field
 * survives the write. Nothing else would repaint the card — a toggled badge
 * would stay visually stale — and, more importantly, the next edit has to be
 * computed against current text, or two edits in a row would apply the second
 * to pre-first-edit YAML and silently revert the first.
 */
function draw(source: string, host: HTMLElement, ctx: FenceRenderContext): void {
  const edit = (change: InterfaceEdit) => {
    const next = applyInterfaceEdit(source, change);
    if (next === source) return;
    ctx.commit(next);
    draw(next, host, ctx);
  };
  host.replaceChildren(buildCard(parseInterfaceBlock(source), ctx.editable, edit));
}

/** @internal — exported for tests, which need the card without a NodeView. */
export function renderInterfaceCard(code: string, host: HTMLElement, ctx: FenceRenderContext): void {
  draw(code, host, ctx);
}

export const interfaceRenderer: FenceRenderer = {
  language: 'interface',
  tabLabel: 'Interface',
  // A signature card is document-width content, not a centred figure.
  layout: 'block',

  render(code, host, ctx) {
    // Throws on malformed input; the NodeView turns that into an inline chip
    // and keeps whatever was rendered last.
    renderInterfaceCard(code, host, ctx);
  },
};

registerFenceRenderer(interfaceRenderer);
