/**
 * NodeView for `code_block`, hosting the Render | Code tab strip.
 *
 * The `contentDOM` (the `<code>` element ProseMirror writes source text into)
 * always exists and remains the authoritative fence body — the tabs only
 * toggle visibility. That makes the Code pane a normal editor surface with the
 * host's undo, autosave and Markdown serialization. Render-pane edits dispatch
 * through `commit` into that same content.
 *
 * A language with no registered renderer falls through to the schema's own
 * `toDOM`, so every other fence behaves exactly as it did before.
 */

import { DOMSerializer, type Node as PMNode } from '@milkdown/prose/model';
import type { Decoration, EditorView, NodeView, NodeViewConstructor, ViewMutationRecord } from '@milkdown/prose/view';
import { fenceModeFromDecorations, setFenceMode, type FenceMode } from './fence-mode';
import { NO_HOST_SERVICES, type FenceHostServices } from './host-services';
import { getFenceRenderer, type FenceRenderer, type FenceTheme } from './registry';

/** Debounce for re-rendering while the user types in the source pane. */
const RENDER_DEBOUNCE_MS = 150;

let blockIdCounter = 0;

function currentTheme(): FenceTheme {
  return document.documentElement.classList.contains('light') ? 'light' : 'dark';
}

type AttributeListener = () => void;

interface AttributeWatch {
  observer: MutationObserver;
  listeners: Set<AttributeListener>;
}

const attributeWatches = new WeakMap<Element, Map<string, AttributeWatch>>();

/**
 * Subscribe to changes of one attribute on one element, sharing a single
 * `MutationObserver` across all subscribers.
 *
 * Every fence watches the same two signals — the theme class on `<html>` and
 * `contenteditable` on the editor root — so a per-instance observer would mean
 * 2N observers on 2 nodes for a document with N renderable fences, all woken by
 * the same mutation. Returns an unsubscribe that disconnects the observer once
 * its last listener goes away.
 */
function watchAttribute(target: Element, attribute: string, listener: AttributeListener): () => void {
  let byAttribute = attributeWatches.get(target);
  if (!byAttribute) {
    byAttribute = new Map();
    attributeWatches.set(target, byAttribute);
  }

  let watch = byAttribute.get(attribute);
  if (!watch) {
    const listeners = new Set<AttributeListener>();
    const observer = new MutationObserver(() => {
      // Copy first: a listener may unsubscribe itself while we iterate.
      for (const fn of [...listeners]) fn();
    });
    observer.observe(target, { attributes: true, attributeFilter: [attribute] });
    watch = { observer, listeners };
    byAttribute.set(attribute, watch);
  }

  const entry = watch;
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      entry.observer.disconnect();
      byAttribute.delete(attribute);
    }
  };
}

/** Reproduces what ProseMirror does when no NodeView claims the node. */
function defaultFenceView(node: PMNode): NodeView {
  const toDOM = node.type.spec.toDOM;
  if (!toDOM) return {} as NodeView;
  const { dom, contentDOM } = DOMSerializer.renderSpec(document, toDOM(node));
  return { dom: dom as HTMLElement, contentDOM: contentDOM ?? undefined };
}

class FenceRenderNodeView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;

  private node: PMNode;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private readonly renderer: FenceRenderer;
  private readonly blockId: string;
  /** Read per render, not captured, so host state stays live. */
  private readonly getHost: () => FenceHostServices;

  private readonly tabs: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly source: HTMLElement;
  private readonly feedback: HTMLElement;
  private readonly renderTab: HTMLButtonElement;
  private readonly codeTab: HTMLButtonElement;

  private mode: FenceMode;
  private unwatch: (() => void)[] = [];
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Everything the last committed render depended on, as one comparable value.
   * Source text, theme and editability always change together as far as this
   * view is concerned — a single signature keeps the guard, the success path
   * and `commit` from drifting out of sync with each other.
   */
  private renderedSignature: string | null = null;
  /**
   * Whether the most recent attempt threw. Needed because the signature records
   * the last *successful* render: editing a good block to a bad one and then
   * back lands on a signature that already matches, so without this flag the
   * guard would skip the re-render and strand the error chip on a block whose
   * source is valid again.
   */
  private lastRenderFailed = false;
  /** Guards against a slow async render landing after a newer one. */
  private renderToken = 0;

  constructor(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
    decorations: readonly Decoration[],
    renderer: FenceRenderer,
    getHost: () => FenceHostServices,
  ) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.renderer = renderer;
    this.getHost = getHost;
    this.blockId = `fence-render-${++blockIdCounter}`;
    this.mode = fenceModeFromDecorations(decorations);

    this.dom = document.createElement('div');
    this.dom.className = 'fence-render-block';
    this.dom.setAttribute('data-language', node.attrs.language as string);
    this.dom.setAttribute('data-testid', 'fence-render-block');

    // ── tab strip ──
    this.tabs = document.createElement('div');
    this.tabs.className = 'fence-render-tabs';
    this.tabs.setAttribute('role', 'tablist');
    this.tabs.setAttribute('contenteditable', 'false');

    this.renderTab = this.makeTab(renderer.tabLabel, 'render');
    this.codeTab = this.makeTab('Code', 'code');
    this.tabs.append(this.renderTab, this.codeTab);

    // ── panes ──
    this.preview = document.createElement('div');
    this.preview.className = 'fence-render-preview';
    this.preview.setAttribute('role', 'tabpanel');
    this.preview.setAttribute('contenteditable', 'false');
    // No click-to-edit handler here on purpose. The Code tab is the affordance
    // now, and swallowing preview clicks would make interactive renderers (the
    // inline-editable interface card) impossible. `stopEvent` keeps ProseMirror
    // out of whatever the renderer puts in this pane.

    this.source = document.createElement('pre');
    this.source.className = 'fence-render-source';
    this.contentDOM = document.createElement('code');
    this.source.appendChild(this.contentDOM);

    // Validation belongs to the fence, not either pane. In particular, putting
    // it inside preview makes malformed YAML invisible at the exact moment the
    // author is correcting it in Code.
    this.feedback = document.createElement('div');
    this.feedback.className = 'fence-render-feedback';
    this.feedback.setAttribute('contenteditable', 'false');
    this.feedback.setAttribute('aria-live', 'polite');
    this.feedback.hidden = true;

    this.dom.append(this.tabs, this.preview, this.source, this.feedback);

    // Both signals are re-checked by the render guard, so these listeners can
    // schedule unconditionally: a mutation that changes nothing costs one
    // early-returning timer.
    //
    // Switching an asset between view and editor mode flips `editable` without
    // touching the document, so no `update()` arrives. ProseMirror mirrors the
    // flag onto its own `contenteditable`, which gives us something to watch.
    this.unwatch = [
      watchAttribute(document.documentElement, 'class', () => this.scheduleRender()),
      watchAttribute(view.dom, 'contenteditable', () => this.scheduleRender()),
    ];

    this.applyMode();
    this.scheduleRender(0);
  }

  /** Everything a render depends on, flattened for a single equality check. */
  private signature(code: string): string {
    return `${currentTheme()}\u0000${String(this.view.editable)}\u0000${code}`;
  }

  private makeTab(label: string, mode: FenceMode): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fence-render-tab';
    button.textContent = label;
    button.setAttribute('role', 'tab');
    button.setAttribute('data-mode', mode);
    button.setAttribute('data-testid', `fence-render-tab-${mode}`);
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const pos = this.getPos();
      if (pos == null) return;
      setFenceMode(this.view, pos, mode);
    });
    return button;
  }

  /**
   * Replace the fence's source text from inside the render pane.
   *
   * Marks the new text as already-rendered *before* dispatching: the resulting
   * `update()` then finds nothing to do and skips the re-render, so interactive
   * DOM (and the user's focus in it) survives the commit. Without that guard,
   * every keystroke in an inline field would tear down the field it was typed
   * into.
   */
  private commit = (rawSource: string): void => {
    // Defence in depth: a renderer is expected to hide its controls when the
    // host is read-only, but the render pane is outside ProseMirror's own
    // editable check, so refuse the write here too.
    if (!this.view.editable) return;
    const pos = this.getPos();
    if (pos == null) return;

    // A fence body never carries a trailing newline — the markdown serializer
    // emits the one before the closing ```. Renderers that build source with a
    // real serializer (`yaml`'s `toString()` always terminates with \n) would
    // otherwise grow a blank line inside the block on every commit.
    const nextSource = rawSource.replace(/\n+$/, '');
    if (nextSource === this.node.textContent) return;

    const { state } = this.view;
    const node = state.doc.nodeAt(pos);
    if (!node || node.type !== this.node.type) return;

    // Record the full signature, not just the source: a commit during the very
    // first render would otherwise leave the theme/editable halves unset, and
    // that mismatch alone would trigger a redundant re-render.
    this.renderedSignature = this.signature(nextSource);
    this.lastRenderFailed = false;
    // Invalidate any render still in flight. A renderer may commit from inside
    // its own `render()` call; without this, that render would resume after the
    // await and overwrite `renderedCode` with the pre-commit text, defeating the
    // suppression and causing an immediate second render.
    this.renderToken++;

    const from = pos + 1;
    const to = pos + node.nodeSize - 1;
    const tr = nextSource
      ? state.tr.replaceWith(from, to, this.view.state.schema.text(nextSource))
      : state.tr.delete(from, to);
    this.view.dispatch(tr);
  };

  private applyMode(): void {
    const showCode = this.mode === 'code';
    this.dom.setAttribute('data-mode', this.mode);
    this.source.hidden = !showCode;
    this.preview.hidden = showCode;
    this.renderTab.setAttribute('aria-selected', String(!showCode));
    this.codeTab.setAttribute('aria-selected', String(showCode));
  }

  private scheduleRender(delay = RENDER_DEBOUNCE_MS): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      void this.render();
    }, delay);
  }

  private async render(): Promise<void> {
    const code = this.node.textContent;
    const signature = this.signature(code);
    if (!this.lastRenderFailed && signature === this.renderedSignature) return;

    const token = ++this.renderToken;
    const theme = currentTheme();
    const editable = this.view.editable;
    const host = document.createElement('div');
    host.className = 'fence-render-output';
    host.dataset.layout = this.renderer.layout ?? 'centered';

    try {
      await this.renderer.render(code, host, {
        theme,
        blockId: this.blockId,
        editable,
        host: this.getHost(),
        commit: this.commit,
      });
      if (token !== this.renderToken) return; // superseded by a newer render
      this.preview.replaceChildren(host);
      this.clearError();
      this.renderedSignature = signature;
      this.lastRenderFailed = false;
    } catch (error) {
      if (token !== this.renderToken) return;
      this.lastRenderFailed = true;
      // Keep the last good output visible and append a chip, so a half-typed
      // block degrades to "stale diagram + error" rather than going blank.
      this.showError(error);
    }
  }

  private clearError(): void {
    this.feedback.replaceChildren();
    this.feedback.hidden = true;
  }

  private showError(error: unknown): void {
    const chip = document.createElement('div');
    chip.className = 'fence-render-error';
    chip.setAttribute('data-testid', 'fence-render-error');
    chip.setAttribute('role', 'alert');
    chip.textContent = error instanceof Error ? error.message : String(error);
    this.feedback.replaceChildren(chip);
    this.feedback.hidden = false;
  }

  update(node: PMNode, decorations: readonly Decoration[]): boolean {
    if (node.type !== this.node.type) return false;
    // A changed info string means a different (or no) renderer — let
    // ProseMirror rebuild the view rather than trying to swap in place.
    if (node.attrs.language !== this.node.attrs.language) return false;

    const textChanged = node.textContent !== this.node.textContent;
    this.node = node;

    const nextMode = fenceModeFromDecorations(decorations);
    if (nextMode !== this.mode) {
      this.mode = nextMode;
      this.applyMode();
    }
    if (textChanged) this.scheduleRender();
    return true;
  }

  private isChrome(target: globalThis.Node): boolean {
    return (
      this.tabs.contains(target) ||
      this.preview.contains(target) ||
      this.feedback.contains(target)
    );
  }

  /** The tabs, preview and validation feedback are chrome, not editable content. */
  stopEvent(event: Event): boolean {
    const target = event.target as globalThis.Node | null;
    return target ? this.isChrome(target) : false;
  }

  /**
   * Renderer output (SVG, cards) must never be parsed back into the document.
   * `ViewMutationRecord` also covers selection changes, which we ignore in the
   * chrome for the same reason.
   */
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return this.isChrome(mutation.target);
  }

  destroy(): void {
    for (const off of this.unwatch) off();
    this.unwatch = [];
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderToken++;
  }
}

/**
 * Build the `code_block` NodeView constructor.
 *
 * Takes a *getter* for host services rather than the services themselves: the
 * plugin is created once at editor construction, but navigation and the active
 * project change under it.
 */
export function createFenceNodeViewConstructor(
  getHost: () => FenceHostServices = () => NO_HOST_SERVICES,
): NodeViewConstructor {
  return (node, view, getPos, decorations) => {
    const renderer = getFenceRenderer(node.attrs.language as string);
    if (!renderer) return defaultFenceView(node);
    return new FenceRenderNodeView(node, view, getPos, decorations, renderer, getHost);
  };
}

/** Default-wired constructor, for tests and for hosts with nothing to lend. */
export const fenceNodeViewConstructor: NodeViewConstructor = createFenceNodeViewConstructor();
