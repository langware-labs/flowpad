/** What a detected link is, and which actions it offers — the pure layers under every link surface. */
import { describe, expect, it } from 'vitest';
import { appLinkPath, lightboxMediaName, linkKind } from '@src/lib/link-kind';
import { linkActions, type LinkContext } from '@src/components/links/link-actions';

const ORIGIN = 'http://localhost:5032';

describe('linkKind', () => {
  it('tells an app address from a web page, an entity and a file', () => {
    expect(linkKind(`${ORIGIN}/dock/explorer/tmp?x=1`, ORIGIN)).toBe('app');
    expect(linkKind('/dock/preferences/appearance', ORIGIN)).toBe('app');
    expect(linkKind('http://localhost:9007/dock/explorer', ORIGIN)).toBe('web');
    expect(linkKind('https://example.org/page', ORIGIN)).toBe('web');
    expect(linkKind('skill-0b6f0a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', ORIGIN)).toBe('entity');
    expect(linkKind('skill-@link-probe', ORIGIN)).toBe('entity');
    for (const file of ['src/a.ts:3', '/tmp/x', 'file:///tmp/a.txt', 'C:\\x\\y.txt', 'README.md']) {
      expect(linkKind(file, ORIGIN)).toBe('file');
    }
  });

  it("rewrites only this origin's app URLs to their in-app address", () => {
    expect(appLinkPath(`${ORIGIN}/dock/explorer/tmp?x=1`, ORIGIN)).toBe('/dock/explorer/tmp?x=1');
    expect(appLinkPath(`${ORIGIN}/assets/logo.png`, ORIGIN)).toBeNull();
    expect(appLinkPath('https://other.test/dock/x', ORIGIN)).toBeNull();
  });

  it('names media by its path, without position or query', () => {
    expect(lightboxMediaName('out/chart.png:3')).toBe('chart.png');
    expect(lightboxMediaName('https://x.test/a/pic.webp?v=1')).toBe('pic.webp');
    expect(lightboxMediaName('src/app.ts:12')).toBeNull();
  });
});

describe('linkActions', () => {
  const ctx = (over: Partial<LinkContext>): LinkContext => ({ kind: 'file', media: false, surface: 'tab', host: false, ...over });

  it('opens as a tab, and offers Vibe only for a process outside vibe', () => {
    expect(linkActions(ctx({}))).toEqual({ primary: 'open', menu: ['copy', 'open', 'browser', 'browser-profile'] });
    expect(linkActions(ctx({ host: true }))).toEqual({
      primary: 'open',
      menu: ['copy', 'open', 'vibe', 'browser', 'browser-profile'],
    });
  });

  it("shows in the host's Display from a vibe surface, keeping a tab one right-click away", () => {
    for (const kind of ['web', 'app', 'entity', 'file'] as const) {
      expect(linkActions(ctx({ kind, surface: 'vibe', host: true }))).toEqual({
        primary: 'show-in-display',
        menu: ['copy', 'show-in-display', 'open', 'browser', 'browser-profile'],
      });
    }
  });

  it('a vibe surface without a host has no Display to show in', () => {
    expect(linkActions(ctx({ surface: 'vibe' })).primary).toBe('open');
  });

  it('previews media first, in every surface', () => {
    expect(linkActions(ctx({ media: true })).primary).toBe('preview');
    expect(linkActions(ctx({ media: true, surface: 'vibe', host: true })).primary).toBe('preview');
  });
});
