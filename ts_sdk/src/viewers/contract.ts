/**
 * The data-viewer contract — how a VALUE of a kind is shown, inside any app's page.
 *
 * A viewer is a webapp asset with `kind: application.web.viewer` whose `views` say, per kind, whether
 * it shows a `single` value, a `collection`, or both (`flow_sdk/schema/data_spec/webapp_spec.py`).
 * Its ES module exports `viewers: { [kind]: { single?, collection? } }`. When anything needs to show
 * a kind, the best viewer for it is used (`flow_sdk/builtin/faas/editors.py::viewers_for`): one nested
 * in the asset being shown, else the most specific kind (by the ontology), else `*` — the generic one.
 *
 * Viewers NEST: a viewer never draws another kind's field itself, it calls `ctx.render(...)` and the
 * registry picks that kind's viewer. Everything a viewer needs arrives in `ctx` (a DOM helper, the
 * generic viewer, kind definitions), so an asset's module imports nothing and runs anywhere.
 *
 * PUBLIC and versioned: authored viewers depend on it. Add, never change; bump `VIEWER_CONTRACT`
 * only for a change an existing viewer could notice.
 */

export const VIEWER_CONTRACT = 1;

/** `line`: one line, for a table cell. `view`: read. `edit`: a form; `read()` answers the value.
 *  `compare`: the value (the right answer) against `other` (what a run answered). */
export type ViewerMode = 'line' | 'view' | 'edit' | 'compare';

/** A shape as a kind declares it (`string`, `?navigation.here`, `enum:a|b`, `[kind]`, `{field: shape}`). */
export type Shape = string | Shape[] | { [field: string]: Shape };

export interface FieldDef {
  shape: Shape;
  description?: string;
  required?: boolean;
}

/** `GET /api/v1/kinds/<kind>` — a record's fields, or a dataset's example slots. */
export interface KindForm {
  kind: string;
  subkind: 'record' | 'dataset';
  description?: string;
  fields?: Record<string, FieldDef>;
  slots?: Partial<Record<'input' | 'context' | 'output', Shape>>;
}

export interface ViewRequest {
  /** The kind to show — a registered kind, or any shape (`?string`, `[navigator.candidate]`). */
  kind: Shape;
  value: unknown;
  mode?: ViewerMode;
  /** compare: what to set the value against. */
  other?: unknown;
  /** What the host knows that the value does not (an eval's `dataset_spec`, metric words).
   *  `omit: string[]` — fields edit mode leaves out (a producer-only field, like a confidence). */
  meta?: Record<string, unknown>;
  /** Something happened the host may act on (`select`, `slice`, `verdict`, `label`). */
  on?: (event: string, detail?: unknown) => void;
}

export interface CollectionRequest {
  kind: Shape;
  items: unknown[];
  /** Highlight one item (an index into `items`). */
  selected?: number;
  meta?: Record<string, unknown>;
  on?: (event: string, detail?: unknown) => void;
}

export interface Mounted {
  /** edit: the value as the person left it. */
  read?: () => unknown;
  /** collection: move the highlight to item `index` (none when undefined) without drawing again. */
  select?: (index?: number) => void;
}

type Child = Node | string | number | null | undefined | false;
/** `h('div', {class, title, onclick}, ...children)` — a tiny DOM builder every viewer shares. */
export type H = (tag: string, attrs?: Record<string, unknown>, ...children: Child[]) => HTMLElement;

export interface ViewerContext {
  h: H;
  /** Show a value of ANY kind here — the nesting. Resolves that kind's viewer. */
  render(el: HTMLElement, request: ViewRequest): Promise<Mounted>;
  renderCollection(el: HTMLElement, request: CollectionRequest): Promise<Mounted>;
  /** A registered kind's definition (null for a primitive or an unknown name). */
  kindForm(kind: string): Promise<KindForm | null>;
  /** The generic viewer, for a custom one that only refines a part (`edit` delegated, say). */
  generic: { single: SingleViewer; collection: CollectionViewer };
}

export interface SingleViewer {
  mount(el: HTMLElement, request: ViewRequest, ctx: ViewerContext): Mounted | Promise<Mounted>;
}

export interface CollectionViewer {
  mount(el: HTMLElement, request: CollectionRequest, ctx: ViewerContext): Mounted | Promise<Mounted>;
}

/** What a viewer module exports. `styles` is injected once, the first time the module is used. */
export interface ViewerModule {
  contract?: number;
  viewers: Record<string, { single?: SingleViewer; collection?: CollectionViewer }>;
  styles?: string;
}

/** One answer of `GET /api/v1/viewers/<kind>` — the best first. */
export interface ViewerChoice {
  typeid: string;
  name: string;
  title: string;
  why: 'nested' | 'kind' | 'any';
  /** The declared kind that matched — the key into the module's `viewers`. */
  kind: string;
  endpoint: string;
  module: string;
}
