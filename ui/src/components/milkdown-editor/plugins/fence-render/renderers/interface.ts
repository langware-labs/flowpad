/**
 * ```interface fences render as an inline-editable signature card.
 *
 * Every value the author wrote is click-to-edit, and the optional badge is a
 * toggle. A committed edit rewrites the block's YAML through
 * `applyInterfaceEdit` (which mutates the author's document in place rather
 * than regenerating it), so switching to the Code tab shows the edit already
 * applied, with comments and formatting intact.
 *
 * Structure — adding/removing fields or changing compact members into object
 * form — is deliberately edited in the Code tab. Existing scalar values,
 * including member descriptions, are editable in the rendered card.
 *
 * Plain DOM, no React root: one root per fence, mounted and unmounted by a
 * ProseMirror NodeView, is a lifecycle hazard for a card this static.
 */

import { FileCode } from 'lucide-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { registerFenceRenderer, type FenceRenderContext, type FenceRenderer } from '../registry';
import { applyInterfaceEdit, type InterfaceEdit } from './interface-edit';
import {
  parseInterfaceBlock,
  type InterfaceMethod,
  type InterfaceParam,
  type InterfaceProperty,
  type InterfaceSpec,
} from './interface-schema';
import { formatSourceLabel, resolveSourceLocation } from './source-location';

/**
 * The chip's glyph, rendered to markup rather than transcribed.
 *
 * This renderer builds plain DOM and cannot mount a React icon, but hand-copying
 * lucide's path data drifts — the first version of this constant was already a
 * stale revision of `file-code`. `renderToStaticMarkup` is the same escape hatch
 * `graph-view/icons/iconToDataUri.ts` uses to get a lucide icon outside a React
 * tree; computed once at module load.
 */
const SOURCE_ICON = renderToStaticMarkup(createElement(FileCode, { width: 12, height: 12, 'aria-hidden': true }));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
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

function paramRow(param: InterfaceParam, canEdit: boolean, edit: (change: InterfaceEdit) => void): HTMLElement {
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
    row.appendChild(
      editable(
        'interface-card-param-desc',
        param.description,
        `interface-param-description-${param.name}`,
        canEdit,
        (value) => edit({ kind: 'param-description', param: param.name, value }),
      ),
    );
  }
  return row;
}

function propertyRow(
  property: InterfaceProperty,
  canEdit: boolean,
  edit: (change: InterfaceEdit) => void,
): HTMLElement {
  const row = el('div', 'interface-card-param interface-card-property');

  row.appendChild(
    editable(
      'interface-card-param-name interface-card-property-name',
      property.name,
      `interface-property-name-${property.name}`,
      canEdit,
      (value) => edit({ kind: 'property-name', property: property.name, value }),
    ),
  );
  row.appendChild(
    editable(
      'interface-card-param-type interface-card-property-type',
      property.type,
      `interface-property-type-${property.name}`,
      canEdit,
      (value) => edit({ kind: 'property-type', property: property.name, value }),
    ),
  );

  if (canEdit || property.optional) {
    const badge = canEdit
      ? el('button', 'interface-card-badge', 'optional')
      : el('span', 'interface-card-badge', 'optional');
    badge.setAttribute('data-testid', `interface-property-optional-${property.name}`);
    badge.setAttribute('aria-pressed', String(property.optional));
    badge.classList.toggle('is-off', !property.optional);
    if (canEdit) {
      (badge as HTMLButtonElement).type = 'button';
      badge.title = property.optional ? 'Make required' : 'Make optional';
      badge.addEventListener('click', () => {
        edit({
          kind: 'property-optional',
          property: property.name,
          optional: !property.optional,
        });
      });
    }
    row.appendChild(badge);
  }

  if (property.description) {
    row.appendChild(
      editable(
        'interface-card-param-desc',
        property.description,
        `interface-property-description-${property.name}`,
        canEdit,
        (value) => edit({ kind: 'property-description', property: property.name, value }),
      ),
    );
  }
  return row;
}

function methodRow(method: InterfaceMethod, canEdit: boolean, edit: (change: InterfaceEdit) => void): HTMLElement {
  const row = el('div', 'interface-card-param interface-card-method');
  row.appendChild(
    editable(
      'interface-card-param-name interface-card-method-name',
      method.name,
      `interface-method-name-${method.name}`,
      canEdit,
      (value) => edit({ kind: 'method-name', method: method.name, value }),
    ),
  );
  row.appendChild(
    editable(
      'interface-card-param-type interface-card-method-signature',
      method.signature,
      `interface-method-signature-${method.name}`,
      canEdit,
      (value) => edit({ kind: 'method-signature', method: method.name, value }),
    ),
  );
  if (method.description) {
    row.appendChild(
      editable(
        'interface-card-param-desc',
        method.description,
        `interface-method-description-${method.name}`,
        canEdit,
        (value) => edit({ kind: 'method-description', method: method.name, value }),
      ),
    );
  }
  return row;
}

type MemberTab = 'methods' | 'properties';

interface InterfaceCardViewState {
  activeMemberTab?: MemberTab;
}

function memberTabs(
  spec: InterfaceSpec,
  canEdit: boolean,
  ctx: FenceRenderContext,
  edit: (change: InterfaceEdit) => void,
  state: InterfaceCardViewState,
): HTMLElement | null {
  if (!spec.methods.length && !spec.properties.length) return null;

  const root = el('div', 'interface-card-members');
  const tabs = el('div', 'interface-card-member-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', `${spec.name} members`);

  const methodsButton = el('button', 'interface-card-member-tab', 'Methods');
  const propertiesButton = el('button', 'interface-card-member-tab', 'Properties');
  methodsButton.type = 'button';
  propertiesButton.type = 'button';
  methodsButton.setAttribute('role', 'tab');
  propertiesButton.setAttribute('role', 'tab');
  methodsButton.setAttribute('data-testid', 'interface-subtab-methods');
  propertiesButton.setAttribute('data-testid', 'interface-subtab-properties');

  const methodsId = `${ctx.blockId}-interface-methods`;
  const propertiesId = `${ctx.blockId}-interface-properties`;
  const methodsTabId = `${methodsId}-tab`;
  const propertiesTabId = `${propertiesId}-tab`;
  methodsButton.id = methodsTabId;
  propertiesButton.id = propertiesTabId;
  methodsButton.setAttribute('aria-controls', methodsId);
  propertiesButton.setAttribute('aria-controls', propertiesId);
  tabs.append(methodsButton, propertiesButton);

  const methodsPanel = el('div', 'interface-card-member-panel');
  const propertiesPanel = el('div', 'interface-card-member-panel');
  methodsPanel.id = methodsId;
  propertiesPanel.id = propertiesId;
  methodsPanel.setAttribute('role', 'tabpanel');
  propertiesPanel.setAttribute('role', 'tabpanel');
  methodsPanel.setAttribute('aria-labelledby', methodsTabId);
  propertiesPanel.setAttribute('aria-labelledby', propertiesTabId);
  methodsPanel.setAttribute('data-testid', 'interface-panel-methods');
  propertiesPanel.setAttribute('data-testid', 'interface-panel-properties');

  if (spec.methods.length) {
    for (const method of spec.methods) methodsPanel.appendChild(methodRow(method, canEdit, edit));
  } else {
    methodsPanel.appendChild(el('div', 'interface-card-member-empty', 'No methods.'));
  }

  if (spec.properties.length) {
    for (const property of spec.properties) {
      propertiesPanel.appendChild(propertyRow(property, canEdit, edit));
    }
  } else {
    propertiesPanel.appendChild(el('div', 'interface-card-member-empty', 'No properties.'));
  }

  const buttons: Record<MemberTab, HTMLButtonElement> = {
    methods: methodsButton,
    properties: propertiesButton,
  };
  const panels: Record<MemberTab, HTMLElement> = {
    methods: methodsPanel,
    properties: propertiesPanel,
  };

  const activate = (tab: MemberTab, focus = false) => {
    state.activeMemberTab = tab;
    for (const candidate of ['methods', 'properties'] as const) {
      const active = candidate === tab;
      buttons[candidate].setAttribute('aria-selected', String(active));
      buttons[candidate].tabIndex = active ? 0 : -1;
      panels[candidate].hidden = !active;
    }
    if (focus) buttons[tab].focus();
  };

  for (const tab of ['methods', 'properties'] as const) {
    buttons[tab].addEventListener('mousedown', (event) => event.preventDefault());
    buttons[tab].addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      activate(tab);
    });
    buttons[tab].addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      activate(tab === 'methods' ? 'properties' : 'methods', true);
    });
  }

  const initial =
    state.activeMemberTab === 'methods' || state.activeMemberTab === 'properties'
      ? state.activeMemberTab
      : spec.methods.length
        ? 'methods'
        : 'properties';
  activate(initial);

  root.append(tabs, methodsPanel, propertiesPanel);
  return root;
}

/**
 * The provenance chip: where this contract is grounded, and a peek at it.
 *
 * Deliberately NOT gated on `canEdit`. Every other control here hides when the
 * host is read-only because it mutates the document; previewing does not, and a
 * read-only surface (the vibe display, a `view`-mode asset) is exactly where
 * following a contract to its source matters most.
 */
function sourceRow(spec: InterfaceSpec, ctx: FenceRenderContext): HTMLElement | null {
  if (!spec.source) return null;

  const location = resolveSourceLocation(spec.source, {
    documentProjectRoot: ctx.host.documentProjectRoot(),
    projectRootById: (id) => ctx.host.projectRootById(id),
  });

  // One chip, like a message attachment: icon + label, click to peek. Opening
  // the file for real is the deliberate step inside the preview, not a second
  // control competing for the same glance.
  const chip = el('button', 'interface-card-source-chip');
  chip.type = 'button';
  chip.setAttribute('data-testid', 'interface-source');
  chip.innerHTML = SOURCE_ICON;
  chip.appendChild(el('span', 'interface-card-source-label', formatSourceLabel(spec.source)));

  if (location.ok) {
    chip.title = `Preview ${location.path}`;
    chip.addEventListener('click', () => {
      ctx.host.previewFile(location.path, { line: location.line });
    });
  } else {
    // A dead chip that says nothing is worse than none — carry the reason the
    // resolver gave us.
    chip.disabled = true;
    chip.title = location.reason;
    chip.setAttribute('data-reason', location.reason);
  }

  const row = el('div', 'interface-card-source');
  row.appendChild(chip);
  return row;
}

function buildCard(
  spec: InterfaceSpec,
  canEdit: boolean,
  ctx: FenceRenderContext,
  edit: (change: InterfaceEdit) => void,
  state: InterfaceCardViewState,
): HTMLElement {
  const card = el('div', 'interface-card');
  card.setAttribute('data-testid', 'interface-card');

  const header = el('div', 'interface-card-header');
  header.appendChild(
    editable('interface-card-name', spec.name, 'interface-name', canEdit, (value) => edit({ kind: 'name', value })),
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

  const members = memberTabs(spec, canEdit, ctx, edit, state);
  if (members) card.appendChild(members);

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

  const source = sourceRow(spec, ctx);
  if (source) card.appendChild(source);

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
function draw(source: string, host: HTMLElement, ctx: FenceRenderContext, state: InterfaceCardViewState): void {
  const edit = (change: InterfaceEdit) => {
    const next = applyInterfaceEdit(source, change);
    if (next === source) return;
    ctx.commit(next);
    draw(next, host, ctx, state);
  };
  host.replaceChildren(buildCard(parseInterfaceBlock(source), ctx.editable, ctx, edit, state));
}

/** @internal — exported for tests, which need the card without a NodeView. */
export function renderInterfaceCard(code: string, host: HTMLElement, ctx: FenceRenderContext): void {
  draw(code, host, ctx, {});
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
