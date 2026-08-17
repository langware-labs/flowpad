/**
 * Registry of fence languages that render as something other than code.
 *
 * A renderer turns the fence's source text into DOM. It can request an ordinary
 * document edit through the host context, but the NodeView owns that write so
 * the source remains a normal code block and Markdown serialization is
 * unchanged.
 */

import type { FenceHostServices } from './host-services';

export type FenceTheme = 'light' | 'dark';

export interface FenceRenderContext {
  theme: FenceTheme;
  /**
   * Stable per-block id, unique within the document and preserved across
   * re-renders of the same block. Use it as a *prefix* for any DOM id you
   * emit — see the mermaid renderer for why an id reused across render
   * attempts can delete the previously committed output.
   */
  blockId: string;
  /**
   * Whether the host document accepts edits.
   *
   * `false` in read-only surfaces — notably the vibe display and any `view`
   * mode asset. An interactive renderer MUST honour this: its controls live in
   * a `contenteditable="false"` pane, so nothing stops them from mutating a
   * document the user isn't supposed to be editing. `commit` is refused in that
   * state too, but a renderer that still draws live-looking controls is lying
   * to the user.
   */
  editable: boolean;
  /**
   * App capabilities a renderer may need — opening a file, locating a project.
   * Handed in because a NodeView has no React context to reach them through.
   */
  host: FenceHostServices;
  /**
   * Replace the fence's source text with `nextSource`.
   *
   * This is how a rendered block edits itself: the write goes into the document
   * as an ordinary ProseMirror transaction, so undo/redo, autosave and the
   * markdown round-trip all behave normally — the thing being written *is* the
   * fence body. The Code tab shows the result immediately.
   *
   * The host suppresses the re-render its own write would otherwise trigger, so
   * a renderer may keep interactive DOM focused across a commit. A no-op when
   * `nextSource` matches the current text, and when the host is not `editable`.
   *
   * Trailing newlines are stripped: a fence body never carries one (the
   * markdown serializer emits the newline before the closing fence), so a
   * renderer built on a real serializer — `yaml`'s `toString()` always
   * terminates with one — can hand its output over as-is.
   */
  commit(nextSource: string): void;
}

export interface FenceRenderer {
  /** The fence info string this renderer claims, e.g. `mermaid`. */
  language: string;
  /** Label for the render tab. The code tab is always labelled "Code". */
  tabLabel: string;
  /**
   * How the render pane should lay the output out.
   *
   * `'centered'` (default) treats it as a figure — a diagram centred in the
   * block. `'block'` treats it as document-width content, e.g. a card or table.
   * Declared here rather than special-cased in the shared stylesheet, which has
   * no business knowing a particular renderer's class names.
   */
  layout?: 'centered' | 'block';
  /**
   * Render `code` into `host`. May be async. `host` is emptied by the caller
   * only on success — throwing leaves the previous good render in place and
   * surfaces the message as an inline error chip, so a half-typed block does
   * not flash to blank.
   */
  render(code: string, host: HTMLElement, ctx: FenceRenderContext): Promise<void> | void;
}

const RENDERERS = new Map<string, FenceRenderer>();

export function registerFenceRenderer(renderer: FenceRenderer): void {
  RENDERERS.set(renderer.language, renderer);
}

/**
 * The renderer for a fence info string, or `undefined` for every language
 * without one — which is the signal to fall back to plain code-fence
 * rendering.
 */
export function getFenceRenderer(language: string | null | undefined): FenceRenderer | undefined {
  if (!language) return undefined;
  return RENDERERS.get(language);
}

/** @internal — test seam. */
export function clearFenceRenderers(): void {
  RENDERERS.clear();
}
