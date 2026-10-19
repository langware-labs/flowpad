// The `dock` display-target kind — a SCREEN, the one show/navigate form that
// reaches a view with no entity or file behind it.
//
// The backend already validated the view and its pointer requirement against
// the dock-address table (`flow_sdk/core/dock_address.py`), so this side is a
// CONSTRUCTION, not a resolution. What these lock is that the construction is
// faithful: the address the backend resolved is the dock the user lands on.
//
// Cases are driven by the shared contract fixture, so this cannot drift from
// the vocabulary the backend validates against.
import { Layout, PageId, ViewType } from '@sdk';
import { describe, expect, it } from 'vitest';
import { dockForDisplayTarget } from '@src/navigation/display-target-pointer';
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

/** Desk-page, default-layout rows — the shape `flow show view` produces. */
const cases = (contract.url_cases as UrlCase[]).filter(
  (c) => !c.base && (c.layout ?? 'dock') === Layout.DOCK,
);

/** The payload `resolve_display_target(dock=…)` puts on the wire.
 *
 *  Empty optionals are OMITTED, not null — persistence drops nulls from
 *  `context_data`, so the backend emits only the keys that carry information
 *  and `last_shown` round-trips byte-for-byte. Build it the same way here, or
 *  this test would be asserting a shape nothing sends. */
const payloadFor = (c: UrlCase) => ({
  kind: 'dock',
  view_type: c.view_type,
  page: c.page ?? PageId.DESK,
  ...(c.pointer ? { pointer: c.pointer } : {}),
  ...(c.options ? { options: c.options } : {}),
});

describe('dockForDisplayTarget — kind: dock', () => {
  it.each(cases.map((c) => [c.name, c] as const))(
    'rebuilds the exact address for: %s',
    (_name, c) => {
      const dock = dockForDisplayTarget(payloadFor(c));
      expect(dock).not.toBeNull();
      expect(dock!.viewType).toBe(c.view_type);
      expect(dock!.pointer || undefined).toBe(c.pointer);
      expect(dock!.page).toBe(c.page ?? PageId.DESK);
      for (const [key, value] of Object.entries(c.options ?? {})) {
        expect(dock!.options?.[key], `option ${key}`).toBe(value);
      }
      // The round trip that matters: the URL the user ends up at is the URL the
      // backend's own builder produced for this address.
      expect(dock!.toUrl('/')).toBe(c.url);
    },
  );

  it('returns null when the payload names no view', () => {
    expect(dockForDisplayTarget({ kind: 'dock' })).toBeNull();
  });

  /* A dock target carries neither `type`/`typeid` nor `path`, so if its branch
   * did not run first it would fall through to the entity/file fallbacks and
   * silently resolve to null. This pins the ordering, not just the mapping. */
  it('is matched before the entity and path fallbacks', () => {
    const dock = dockForDisplayTarget({ kind: 'dock', view_type: ViewType.EVENTS, page: PageId.DESK });
    expect(dock?.viewType).toBe(ViewType.EVENTS);
  });

  /* Vibe adopts a shown screen as a workspace child; the chip needs a tab
   * identity to exist at all. (Home is the fullbleed exception and is not an
   * addressable show target.) */
  it('produces a dock that can be a tab', () => {
    const dock = dockForDisplayTarget(payloadFor(cases[0]));
    expect(dock!.tabHash).not.toBeNull();
  });
});
