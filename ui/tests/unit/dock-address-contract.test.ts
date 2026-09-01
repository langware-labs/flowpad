// Dock addressing — TypeScript side of the cross-language contract.
// tests/fixtures/dock_address_contract.json is ALSO parsed by
// tests/unit/test_dock_address_contract.py. The two suites pin one view
// vocabulary, one retirement map, one per-view classification and one URL
// grammar, so a backend-constructed address (`flow show view` / `flow navigate
// view`) and a clicked dock cannot drift apart. Change the fixture only with
// both suites in hand.
//
// Tests under "TypeScript-exclusive" are checks only this side can make —
// chiefly the tabHash STRINGS, which Python deliberately never mirrors (it
// pins their null-ness only; see the dock_address.py docstring).
import { AIConfigSubview, CredentialsSubview, Layout, MachineSubview, PageId, TokenPlanKind, ViewType, WebappSubview, isValidPage } from '@sdk';
import { RETIRED_DOCK_VIEWS, normalizeRetiredDockPointer } from '@sdk/utils/ui/retired-views';
import { describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { buildDockUrl, parseDockUrl } from '@src/navigation/url-builder';
import { isValidView } from '@src/navigation/validators';
import { VIEWER_REGISTRY } from '@src/types/ViewType';
import contract from '../../../tests/fixtures/dock_address_contract.json';

type UrlCase = {
  name: string;
  view_type: string;
  pointer?: string;
  options?: Record<string, string>;
  layout?: string;
  page?: string;
  base?: string;
  url: string;
};

type TabCase = { name: string; view_type: string; pointer?: string | null; page?: string; tab_hash: string | null };

const urlCases = contract.url_cases as UrlCase[];
const tabCases = contract.tab_identity_cases as TabCase[];

/** A DockPointer for a contract row, applying the fixture's documented defaults. */
const dockFor = (c: UrlCase | TabCase, pointer?: string | null) =>
  new DockPointer(
    c.view_type as ViewType,
    (pointer ?? (c as UrlCase).pointer) || undefined,
    (c as UrlCase).options,
    (((c as UrlCase).layout as Layout) ?? Layout.DOCK),
    ((c.page as PageId) ?? PageId.DESK),
  );

describe('dock-address contract (shared fixture)', () => {
  // ── shared assertions — the Python suite makes each of these too ─────────

  it('exposes the same layout vocabulary, in the same order', () => {
    expect(Object.values(Layout)).toEqual(contract.layouts);
  });

  it('exposes the same page vocabulary, and the same default', () => {
    expect(Object.values(PageId)).toEqual(contract.pages);
    expect(PageId.DESK).toBe(contract.default_page);
  });

  /* Order-sensitive: a member inserted mid-list is a deliberate fixture edit. */
  it('exposes the same view vocabulary, in the same order', () => {
    expect(Object.values(ViewType)).toEqual(contract.view_types);
  });

  it.each([
    ['credentials', CredentialsSubview],
    ['web-app', WebappSubview],
    ['machine', MachineSubview],
    ['ai-config', AIConfigSubview],
    ['token-plan', TokenPlanKind],
  ] as const)('exposes the same %s subview vocabulary', (key, enumObj) => {
    expect(Object.values(enumObj)).toEqual(
      (contract.subview_vocabularies as Record<string, string[]>)[key],
    );
  });

  it('retires the same views to the same targets', () => {
    const actual = Object.fromEntries(
      Object.entries(RETIRED_DOCK_VIEWS).map(([view, target]) => [
        view,
        { view_type: target!.viewType as string, pointer: target!.pointer },
      ]),
    );
    expect(actual).toEqual(contract.retired_views);
  });

  it.each(Object.keys(contract.retired_views))('resolves the retired %s forward', (retired) => {
    const expected = (contract.retired_views as Record<string, { view_type: string; pointer: string }>)[retired];
    const resolved = normalizeRetiredDockPointer({
      viewType: retired as ViewType,
      pointer: 'ignored-by-the-replacement',
    });
    expect(resolved.viewType).toBe(expected.view_type);
    expect(resolved.pointer).toBe(expected.pointer);
  });

  it('passes a live view through the retirement resolver untouched', () => {
    const live = { viewType: ViewType.EVENTS, pointer: 'x' };
    expect(normalizeRetiredDockPointer(live)).toEqual(live);
  });

  /* `view_meta` has no single TS home — it is DERIVED from VIEWER_REGISTRY
   * here, which is what makes this an independent statement rather than a copy
   * of the Python table. `pointer` (the requirement) is fixture-only on this
   * side: TypeScript never encodes it, so it is asserted through url_cases and
   * by the Python validator instead. */
  it.each(Object.keys(contract.view_meta))('classifies %s the same way', (view) => {
    const expected = (contract.view_meta as Record<string, Record<string, unknown>>)[view];
    const meta = VIEWER_REGISTRY[view as ViewType];
    expect(!!meta, `${view} addressable`).toBe(expected.addressable);
    expect(!!meta?.foldsPointer, `${view} foldsPointer`).toBe(expected.folds_pointer);
    expect(!!meta?.scopeKeyed, `${view} scopeKeyed`).toBe(expected.scope_keyed);
    expect(meta?.chrome ?? 'workspace', `${view} chrome`).toBe(expected.chrome);
  });

  it.each(urlCases.map((c) => [c.name, c] as const))('builds the URL for: %s', (_name, c) => {
    const url = buildDockUrl(
      c.base ?? '',
      c.view_type as ViewType,
      c.pointer,
      c.options,
      (c.layout as Layout) ?? Layout.DOCK,
      (c.page as PageId) ?? PageId.DESK,
    );
    expect(url).toBe(c.url);
  });

  /* `parseDockUrl` is the low-level PATH splitter: it takes a pathname, and
   * deliberately returns the pointer still percent-encoded — decoding (and the
   * query string) belong to `DockPointer.fromUrl` below. Pin it on the rows
   * where those two concerns don't apply, so the split itself stays covered
   * without asserting behaviour it doesn't have. */
  it.each(
    urlCases
      .filter((c) => !c.options && !c.base && c.url === encodeURI(c.url))
      .map((c) => [c.name, c] as const),
  )('splits the path for: %s', (_name, c) => {
    const parsed = parseDockUrl(c.url);
    expect(parsed.viewType).toBe(c.view_type);
    expect(parsed.pointer || undefined).toBe(c.pointer);
    expect(parsed.layout ?? Layout.DOCK).toBe((c.layout as Layout) ?? Layout.DOCK);
    expect(parsed.page ?? PageId.DESK).toBe((c.page as PageId) ?? PageId.DESK);
  });

  // ── TypeScript-exclusive: checks Python cannot (or must not) make ────────

  /* THE tab-identity strings. Python pins only whether the hash is null,
   * because `DockPointer.tabHash` is the single canonicalizer and `Tab.id` is
   * uuid5 over its output — a second implementation would silently re-key
   * every persisted tab row. This is the mirror of the Python side's
   * EntityType cross-check: each language asserts what only it owns. */
  it.each(tabCases.map((c) => [c.name, c] as const))('derives the tab hash for: %s', (_name, c) => {
    expect(dockFor(c, c.pointer).tabHash).toBe(c.tab_hash);
  });

  it('accepts every contract view as a valid view', () => {
    for (const view of contract.view_types) expect(isValidView(view)).toBe(true);
  });

  it('accepts every contract page as a valid page', () => {
    for (const page of contract.pages) expect(isValidPage(page)).toBe(true);
  });

  /* THE round-trip that matters: a dock decoded from a URL must carry back the
   * exact address the backend built — decoded pointer, options and all — and
   * must re-emit that same URL. This is the property `flow show view` /
   * `flow navigate view` depend on when they hand an address to the frontend. */
  it.each(urlCases.filter((c) => !c.base).map((c) => [c.name, c] as const))(
    'DockPointer.fromUrl round-trips: %s',
    (_name, c) => {
      const dock = DockPointer.fromUrl(`http://localhost${c.url}`);
      expect(dock.viewType).toBe(c.view_type);
      expect(dock.pointer || undefined).toBe(c.pointer);
      expect(dock.page).toBe((c.page as PageId) ?? PageId.DESK);
      expect(dock.layout).toBe((c.layout as Layout) ?? Layout.DOCK);
      for (const [key, value] of Object.entries(c.options ?? {})) {
        expect(dock.options?.[key], `option ${key}`).toBe(value);
      }
      expect(dock.toUrl('/')).toBe(c.url);
    },
  );
});
