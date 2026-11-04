/**
 * The three retired credential views resolve forward.
 *
 * `environment`, `connections`, and `api-keys` were sibling view types
 * rendering what is now the single Connections surface. They stay decodable — links,
 * bookmarks, and saved tabs are already out there — and land on the tab that
 * replaced them.
 */
import { CredentialsSubview, ViewType } from '@sdk';
import { describe, it, expect } from 'vitest';

import { canonicalRetiredViewDockPath } from '@src/navigation/retired-views-dock-canonicalization';
import { normalizeRetiredDockPointer, Tab } from '@sdk';

describe('canonicalRetiredViewDockPath', () => {
  it.each([
    ['/dock/environment', '/dock/credentials/connections'],
    ['/dock/connections', '/dock/credentials/connections'],
    ['/dock/api-keys', '/dock/credentials/connections'],
    ['/dock/skills', '/dock/assets/list/skill'],
  ])('redirects %s', (from, to) => {
    expect(canonicalRetiredViewDockPath(from, '')).toBe(to);
  });

  it('keeps the page segment', () => {
    expect(canonicalRetiredViewDockPath('/dock/hub/connections', '')).toBe('/dock/hub/credentials/connections');
  });

  it('handles the dev and win dock prefixes', () => {
    expect(canonicalRetiredViewDockPath('/dev/environment', '')).toBe('/dev/credentials/connections');
    expect(canonicalRetiredViewDockPath('/win/hub/api-keys', '')).toBe('/win/hub/credentials/connections');
  });

  it('preserves the query string, which may hold unrelated dock options', () => {
    expect(canonicalRetiredViewDockPath('/dock/environment', '?layout=split')).toBe(
      '/dock/credentials/connections?layout=split',
    );
  });

  it('drops a trailing segment — none of the three ever carried a pointer', () => {
    expect(canonicalRetiredViewDockPath('/dock/environment/whatever', '')).toBe('/dock/credentials/connections');
  });

  it.each([
    ['/dock/data-sources/channels', '/dock/inbound'],
    ['/dock/hub/data-sources/channels', '/dock/hub/inbound'],
  ])('redirects the retired Data sources › Channels section %s', (from, to) => {
    expect(canonicalRetiredViewDockPath(from, '')).toBe(to);
  });

  it('leaves the live Data sources sections alone', () => {
    expect(canonicalRetiredViewDockPath('/dock/data-sources', '')).toBeNull();
    expect(canonicalRetiredViewDockPath('/dock/data-sources/drivers', '')).toBeNull();
    expect(canonicalRetiredViewDockPath('/dock/data-sources/constructor', '')).toBeNull();
  });

  it('leaves everything else alone, including the view that replaced them', () => {
    expect(canonicalRetiredViewDockPath('/dock/credentials/connections', '')).toBeNull();
    expect(canonicalRetiredViewDockPath('/dock/home', '')).toBeNull();
    expect(canonicalRetiredViewDockPath('/dock/hub/worldview/world', '')).toBeNull();
    // Not a dock URL at all.
    expect(canonicalRetiredViewDockPath('/environment', '')).toBeNull();
  });
});

describe('normalizeRetiredDockPointer', () => {
  it.each([
    [ViewType.ENVIRONMENT, CredentialsSubview.CONNECTIONS],
    [ViewType.CONNECTIONS, CredentialsSubview.CONNECTIONS],
    [ViewType.API_KEYS, CredentialsSubview.CONNECTIONS],
  ])('resolves a saved %s tab', (retired, subview) => {
    expect(normalizeRetiredDockPointer({ viewType: retired })).toEqual({
      viewType: ViewType.CREDENTIALS,
      pointer: subview,
    });
  });

  it('returns a live pointer untouched, so callers can apply it unconditionally', () => {
    const live = { viewType: ViewType.ASSETS, pointer: 'list/task' };

    expect(normalizeRetiredDockPointer(live)).toBe(live);
  });

  it('keeps the rest of the pointer', () => {
    expect(normalizeRetiredDockPointer({ viewType: ViewType.CONNECTIONS, options: { layout: 'split' } })).toEqual({
      viewType: ViewType.CREDENTIALS,
      pointer: CredentialsSubview.CONNECTIONS,
      options: { layout: 'split' },
    });
  });
});

describe('a saved Tab row on a retired section', () => {
  it('normalizes data-sources / channels to the Channels screen', () => {
    const tab = new Tab({
      id: '00000000-0000-4000-8000-000000000001',
      pointer: JSON.stringify({ viewType: ViewType.DATA_SOURCES, pointer: 'channels' }),
    });
    expect(tab.dockPointer).toMatchObject({ viewType: ViewType.INBOUND, pointer: '', tabHash: 'inbound|' });
  });

  it('leaves a saved live Data sources section alone', () => {
    const tab = new Tab({
      id: '00000000-0000-4000-8000-000000000002',
      pointer: JSON.stringify({ viewType: ViewType.DATA_SOURCES, pointer: 'drivers' }),
    });
    expect(tab.dockPointer).toMatchObject({ viewType: ViewType.DATA_SOURCES, pointer: 'drivers' });
  });
});
