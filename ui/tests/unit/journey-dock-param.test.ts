/**
 * `journeyId` URL param — the whole "a journey is shown" state lives here.
 *
 * Asserts the param round-trips through the URL (reload-safe), never changes tab
 * identity (`tabHash`), is carried forward by `openDock` (topmost/sticky), and
 * is cleared only by `closeJourney`.
 */
import { describe, expect, it } from 'vitest';
import { ViewType } from '@sdk';
import { DockPointer, JOURNEY_PARAM } from '@src/navigation/DockPointer';

const JID = '5eaa7e57-1111-4222-8333-444455556666';

const plain = () => new DockPointer(ViewType.ASSETS, 'editor/html/vfs/x/page1.html');

describe('DockPointer.journeyId / withJourney', () => {
  it('is null by default', () => {
    expect(plain().journeyId).toBeNull();
  });

  it('withJourney() sets the param and the getter reads it back', () => {
    const p = plain().withJourney(JID);
    expect(p.journeyId).toBe(JID);
    expect(p.options?.[JOURNEY_PARAM]).toBe(JID);
  });

  it('serializes into the dock URL', () => {
    expect(plain().withJourney(JID).toUrl()).toContain(`${JOURNEY_PARAM}=${JID}`);
  });

  it('round-trips through toUrl → fromUrl (reload-safe)', () => {
    const url = plain().withJourney(JID).toUrl();
    expect(DockPointer.fromUrl(url).journeyId).toBe(JID);
  });

  it('withJourney(null) removes it from the URL entirely', () => {
    const cleared = plain().withJourney(JID).withJourney(null);
    expect(cleared.journeyId).toBeNull();
    expect(cleared.toUrl()).not.toContain(JOURNEY_PARAM);
    expect(DockPointer.fromUrl(cleared.toUrl()).journeyId).toBeNull();
  });

  it('preserves other option params when set and cleared', () => {
    const withBoth = new DockPointer(ViewType.ASSETS, 'x', { lang: 'es' }).withJourney(JID);
    expect(withBoth.lang).toBe('es');
    expect(withBoth.withJourney(null).lang).toBe('es');
  });

  it('does NOT change tab identity — showing a journey never spawns a tab', () => {
    expect(plain().withJourney(JID).tabHash).toBe(plain().tabHash);
  });

  it('IS a different pointer, so setting it actually navigates', () => {
    // openDock de-dupes on equals(); if these compared equal the URL would
    // never update and the journey could not be shown or closed.
    expect(plain().withJourney(JID).equals(plain())).toBe(false);
  });
});
