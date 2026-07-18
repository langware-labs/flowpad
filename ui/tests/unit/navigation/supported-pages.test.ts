/**
 * Server-declared supported pages → redirect policy. The backend reports which
 * pages it serves on bootstrap (`supported_pages`); navigation to a page not in
 * that set redirects to the first supported page's home.
 */
import { describe, expect, it } from 'vitest';
import { PageId, ViewType } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { normalizeSupportedPages, pageRedirectUrl } from '@src/navigation/supported-pages';

describe('normalizeSupportedPages', () => {
  it('keeps known page ids in order', () => {
    expect(normalizeSupportedPages(['desk', 'hub'])).toEqual([PageId.DESK, PageId.HUB]);
    expect(normalizeSupportedPages(['hub'])).toEqual([PageId.HUB]);
  });

  it('falls back to [desk] for missing / empty / all-unknown lists', () => {
    expect(normalizeSupportedPages(undefined)).toEqual([PageId.DESK]);
    expect(normalizeSupportedPages(null)).toEqual([PageId.DESK]);
    expect(normalizeSupportedPages([])).toEqual([PageId.DESK]);
    expect(normalizeSupportedPages(['nope', 'other'])).toEqual([PageId.DESK]);
  });

  it('drops unknown entries but keeps the known ones', () => {
    expect(normalizeSupportedPages(['desk', 'bogus'])).toEqual([PageId.DESK]);
  });
});

describe('pageRedirectUrl', () => {
  const deskDock = new DockPointer(ViewType.ASSETS, 'list/skill');
  const hubDock = new DockPointer(ViewType.ASSETS, 'list/skill', {}, undefined, PageId.HUB);

  it('returns null when the dock page is supported', () => {
    expect(pageRedirectUrl(deskDock, ['desk'])).toBeNull();
    expect(pageRedirectUrl(hubDock, ['desk', 'hub'])).toBeNull();
  });

  it('redirects an unsupported hub page to the desk home', () => {
    expect(pageRedirectUrl(hubDock, ['desk'])).toBe('/dock/home');
  });

  it('redirects an unsupported desk page to the first supported page home', () => {
    // Server serves only hub → desk URLs bounce to hub home.
    expect(pageRedirectUrl(deskDock, ['hub'])).toBe('/dock/hub/home');
  });

  it('treats a missing/unknown list as desk-only', () => {
    // No usable list → desk is the sole supported page: desk stays, hub bounces.
    expect(pageRedirectUrl(deskDock, undefined)).toBeNull();
    expect(pageRedirectUrl(hubDock, ['garbage'])).toBe('/dock/home');
  });

  it('preserves the scope/base path prefix when redirecting', () => {
    expect(pageRedirectUrl(hubDock, ['desk'], '/agent/a/flow/f/dock/hub/assets/list/skill')).toBe(
      '/agent/a/flow/f/dock/home',
    );
  });
});
