/**
 * Showing a value: resolve the best viewer for its kind, import it once, mount it — and when a
 * viewer cannot load or mount, show the generic one with a small warning rather than nothing.
 *
 * `createViewerContext()` is the one entry: `ctx.render(el, {kind, value, mode})` and
 * `ctx.renderCollection(el, {kind, items})`. The context it hands each viewer is the same one, so
 * every nested field resolves its own kind's viewer — that is the nesting.
 */
import apiClient from '../client';
import { serviceUrlOf } from '../entities/service-endpoint';
import type {
  CollectionRequest,
  KindForm,
  Mounted,
  ViewerChoice,
  ViewerContext,
  ViewerModule,
  ViewRequest,
} from './contract';
import { h, injectStyles } from './dom';
import { GENERIC_VIEWER_STYLES, genericCollection, genericSingle } from './generic';
import { kindForm as fetchKindForm, namedKind, parseValueRef } from './kinds';

/** Whether a viewer shows one value or a list of them (`ViewShape` in `webapp_spec.py`). */
type ViewShape = 'single' | 'collection';

export interface ViewerHost {
  /** The asset being shown (a typeid) — a viewer nested in it wins. */
  within?: string;
  /** Seams for tests: where definitions, choices and modules come from. */
  kindForm?: (kind: string) => Promise<KindForm | null>;
  choices?: (kind: string, shape: ViewShape, within?: string) => Promise<ViewerChoice[]>;
  importModule?: (choice: ViewerChoice) => Promise<ViewerModule>;
  /** A stored value by its reference (`<kind>.id.<uuid>`), looked up in `within` first. */
  value?: (ref: string, within?: string) => Promise<StoredValue>;
  /** What the app does when a viewer opens a part on its own (`ctx.open`) or an entity (`ctx.navigate`). */
  open?: ViewerContext['open'];
  navigate?: ViewerContext['navigate'];
}

export interface StoredValue {
  kind: string;
  id: string;
  ref: string;
  value: unknown;
}

const choiceCache = new Map<string, Promise<ViewerChoice[]>>();
const moduleCache = new Map<string, Promise<ViewerModule>>();

/** Remember a lookup; a failure is forgotten so the next use asks again. */
function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  if (!cache.has(key))
    cache.set(
      key,
      load().catch((error) => {
        cache.delete(key);
        throw error;
      }),
    );
  return cache.get(key)!;
}

function fetchChoices(kind: string, shape: ViewShape, within?: string): Promise<ViewerChoice[]> {
  const query = new URLSearchParams({ shape, ...(within ? { within } : {}) });
  return cached(choiceCache, `${kind}|${query}`, async () =>
    (await apiClient.get<ViewerChoice[]>(`/api/v1/viewers/${encodeURIComponent(kind)}?${query}`)) ?? []).catch(() => []);
}

const valueCache = new Map<string, Promise<StoredValue>>();
/** A value is read from the asset that keeps it (`within`) — with none, nothing can be looked in. */
function fetchValue(ref: string, within?: string): Promise<StoredValue> {
  if (!within) return Promise.reject(new Error(`no asset to read ${ref} from`));
  return cached(valueCache, `${ref}|${within}`, async () => {
    const got = await apiClient.get<StoredValue>(`/api/v1/values/${encodeURIComponent(ref)}?${new URLSearchParams({ within })}`);
    if (!got) throw new Error(`no value ${ref}`);
    return got;
  });
}

/** The module's address is the SDK's to make (`serviceUrlOf`), never the app's. */
function importChoice(choice: ViewerChoice): Promise<ViewerModule> {
  const url = serviceUrlOf(choice.endpoint, choice.module);
  return cached(moduleCache, url, () => import(/* @vite-ignore */ url) as Promise<ViewerModule>);
}

export function createViewerContext(host: ViewerHost = {}): ViewerContext {
  const choices = host.choices ?? fetchChoices;
  const load = host.importModule ?? importChoice;
  injectStyles('generic', GENERIC_VIEWER_STYLES);

  /** The custom viewer for a kind and shape, with its name — or null for the generic one. */
  async function resolve(kindShape: unknown, shape: ViewShape) {
    const kind = namedKind(kindShape as never);
    if (!kind) return null;
    for (const choice of await choices(kind, shape, host.within)) {
      const mod = await load(choice);
      injectStyles(choice.typeid, mod.styles);
      const viewer = mod.viewers?.[choice.kind]?.[shape];
      if (viewer) return { viewer, name: choice.title || choice.name };
    }
    return null;
  }

  /** One viewer failing never blanks the page: say so, and show the generic view under it. */
  function warnThen(el: HTMLElement, why: string, error: unknown, then: (target: HTMLElement) => Mounted | Promise<Mounted>) {
    console.warn(`[viewer] ${why} — showing the generic view`, error);
    const body = h('div');
    el.replaceChildren(h('span', { class: 'dv-warn', title: String((error as Error)?.message ?? error) }, `${why} — generic view`), body);
    return then(body);
  }

  async function mountWith<R extends { kind: unknown }>(
    el: HTMLElement,
    request: R,
    shape: ViewShape,
    fallback: { mount: (el: HTMLElement, r: R, c: ViewerContext) => Mounted | Promise<Mounted> },
  ): Promise<Mounted> {
    let found: Awaited<ReturnType<typeof resolve>> = null;
    try {
      found = await resolve(request.kind, shape);
    } catch (error) {
      return warnThen(el, `the viewer for ${String(namedKind(request.kind as never))} did not load`, error, (t) => fallback.mount(t, request, ctx));
    }
    if (!found) return fallback.mount(el, request, ctx);
    try {
      return await (found.viewer as unknown as typeof fallback).mount(el, request, ctx);
    } catch (error) {
      return warnThen(el, `${found.name} could not show this`, error, (t) => fallback.mount(t, request, ctx));
    }
  }

  /** A value given by reference (`<kind>.id.<uuid>`) is drawn as the value it names — read from
   *  the asset being shown (`within`); a viewer learns which (`meta.ref`). Anything else as is. */
  async function dereference(value: unknown): Promise<{ value: unknown; ref?: string } | { missing: string; error: unknown }> {
    if (!parseValueRef(value)) return { value };
    try {
      const stored = await (host.value ?? fetchValue)(value as string, host.within);
      return { value: stored.value, ref: stored.ref };
    } catch (error) {
      return { missing: value as string, error };
    }
  }

  /** A reference nothing keeps says so — never a blank. */
  function missing(el: HTMLElement, { missing: ref, error }: { missing: string; error: unknown }): Mounted {
    console.warn(`[viewer] ${ref} could not be read`, error);
    el.replaceChildren(h('span', { class: 'dv-warn', title: String((error as Error)?.message ?? error) }, `not found: ${ref}`));
    return {};
  }

  const ctx: ViewerContext = {
    h,
    kindForm: host.kindForm ?? fetchKindForm,
    generic: { single: genericSingle, collection: genericCollection },
    open: host.open,
    navigate: host.navigate,
    render: async (el: HTMLElement, request: ViewRequest) => {
      const got = await dereference(request.value);
      if ('missing' in got) return missing(el, got);
      const meta = got.ref ? { ...request.meta, ref: got.ref } : request.meta;
      return mountWith(el, { ...request, value: got.value, meta }, 'single', genericSingle);
    },
    renderCollection: async (el: HTMLElement, request: CollectionRequest) => {
      const got = await Promise.all(request.items.map(dereference));
      const lost = got.find((g) => 'missing' in g);
      if (lost) return missing(el, lost);
      return mountWith(el, { ...request, items: got.map((g) => ('value' in g ? g.value : null)) }, 'collection', genericCollection);
    },
  };
  return ctx;
}
