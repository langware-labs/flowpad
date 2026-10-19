import { describe, expect, it } from 'vitest';
import { Layout, PageId, ViewType } from '@sdk';
import { projectScope } from '@src/lib/scope-filter';
import { DockPointer } from '@src/navigation/DockPointer';
import { dockTarget } from '@src/tags/dock-target';

/**
 * The app root `/` is a LOCATION LIKE ANY OTHER — a `DockPointer`.
 *
 * It used to be the absence of one (`currentDock === null`), which meant every
 * code path that had to work "wherever the user is, dock or home" had no type to
 * hold and fell back to raw URL strings. That hole is what let a journey's
 * highlight write rebuild a stale URL and revert a navigation in flight (see
 * `navigation-pending-compose.test.ts`).
 *
 * These tests pin the collapse: one location type, `/` still the canonical
 * spelling, and — critically — the root is NOT a tab.
 */

const root = () => DockPointer.root();

describe('the app root is a DockPointer', () => {
  it('serializes to `/`, not `/dock/home`', () => {
    expect(root().toUrl()).toBe('/');
  });

  it('round-trips through the URL', () => {
    expect(DockPointer.fromUrl('/').toUrl()).toBe('/');
  });

  it('is the desk HOME surface', () => {
    const dock = DockPointer.fromUrl('/');
    expect(dock.viewType).toBe(ViewType.HOME);
    expect(dock.page).toBe(PageId.DESK);
    expect(dock.pointer).toBeUndefined();
  });

  it('is NOT a tab — no chip is minted for the home', () => {
    // HOME is `chrome: 'fullbleed'`, and a fullbleed view has no tabHash. This
    // is what keeps a Home chip out of the strip now that root is a pointer.
    expect(root().tabHash).toBeNull();
    expect(root().toJSON()).toBeNull();
  });
});

describe('the root carries options as data, not as a hand-built query string', () => {
  it('round-trips a sticky journey id', () => {
    const dock = root().withJourney('@vibe-exit-mode-switch');
    expect(dock.toUrl()).toBe('/?journeyId=%40vibe-exit-mode-switch');
    const back = DockPointer.fromUrl(dock.toUrl());
    expect(back.journeyId).toBe('@vibe-exit-mode-switch');
    expect(back.toUrl()).toBe(dock.toUrl());
  });

  it('round-trips a highlight', () => {
    const dock = root().withHighlight('ViewModeVibe');
    expect(DockPointer.fromUrl(dock.toUrl()).highlight).toBe('ViewModeVibe');
  });

  it('holds a highlight and a journey id at once', () => {
    // The old hand-built `/?journeyId=…` branch in `showJourney` dropped every
    // other param, `highlight` included. Composing on the pointer cannot.
    const dock = root().withJourney('@probe').withHighlight('ViewToggle');
    const back = DockPointer.fromUrl(dock.toUrl());
    expect(back.journeyId).toBe('@probe');
    expect(back.highlight).toBe('ViewToggle');
  });

  it('round-trips a scope filter — `/?scope-…` now means what `/dock/home?scope-…` meant', () => {
    const projectId = '11111111-1111-4111-8111-111111111111';
    const dock = root().withScopeFilter(projectScope(projectId));
    expect(DockPointer.fromUrl(dock.toUrl()).scopeProjectId).toBe(projectId);
  });

  it('drops an option back off again, returning to a bare `/`', () => {
    expect(root().withJourney('@probe').withJourney(null).toUrl()).toBe('/');
  });

  it('options never make the root a tab', () => {
    expect(root().withJourney('@probe').withHighlight('X').tabHash).toBeNull();
  });
});

describe('the root keeps its identity on the bus', () => {
  it('is `dock:home` — with no trailing slash', () => {
    // `dockTarget` is `dock:<viewType>/<pointer>`, so a pointer-less root would
    // naively render `dock:home/` and silently break every journey route-await
    // (`await: { home: true }` resolves to this exact string).
    expect(dockTarget(root())).toBe('dock:home');
  });

  it('agrees with what a null dock used to emit', () => {
    expect(dockTarget(root())).toBe(dockTarget(null));
  });

  it('is not confused with the hub home', () => {
    expect(dockTarget(DockPointer.forHome().withPage(PageId.HUB))).not.toBe('dock:home');
  });
});

describe('the hub home is a different surface and is NOT collapsed', () => {
  it('keeps its dock URL', () => {
    expect(DockPointer.forHome().withPage(PageId.HUB).toUrl()).toBe('/dock/hub/home');
  });

  it('round-trips', () => {
    const url = DockPointer.forHome().withPage(PageId.HUB).toUrl();
    expect(DockPointer.fromUrl(url).page).toBe(PageId.HUB);
    expect(DockPointer.fromUrl(url).toUrl()).toBe(url);
  });
});

describe('desk HOME with a pointer keeps its dock URL', () => {
  it('only the POINTER-LESS desk home collapses to `/`', () => {
    // `use-ui-command-listener` builds `/dock/home/<typeid>` for an entity with
    // no dockPointer of its own; that is still a dock URL.
    const dock = new DockPointer(ViewType.HOME, 'projects');
    expect(dock.toUrl()).toBe('/dock/home/projects');
    expect(DockPointer.fromUrl(dock.toUrl()).toUrl()).toBe(dock.toUrl());
  });
});

describe('a genuinely malformed pointer still fails loudly', () => {
  it('a viewType-less pointer is not silently treated as the root', () => {
    // The root is an EXPLICIT value (`DockPointer.root()`), so `toUrl()` keeps
    // its malformed-pointer guard rather than quietly serializing junk to `/`.
    expect(() => new DockPointer().toUrl()).toThrow();
  });
});

describe('base paths and layouts are unaffected', () => {
  it('the root under a window layout is still the root', () => {
    expect(DockPointer.root().layout).toBe(Layout.DOCK);
  });
});
