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

import { canonicalCredentialsDockPath } from '@src/navigation/credentials-dock-canonicalization';
import { normalizeRetiredDockPointer } from '@sdk';

describe('canonicalCredentialsDockPath', () => {
  it.each([
    ['/dock/environment', '/dock/credentials/connections'],
    ['/dock/connections', '/dock/credentials/connections'],
    ['/dock/api-keys', '/dock/credentials/connections'],
    ['/dock/skills', '/dock/assets/list/skill'],
  ])('redirects %s', (from, to) => {
    expect(canonicalCredentialsDockPath(from, '')).toBe(to);
  });

  it('keeps the page segment', () => {
    expect(canonicalCredentialsDockPath('/dock/hub/connections', '')).toBe('/dock/hub/credentials/connections');
  });

  it('handles the dev and win dock prefixes', () => {
    expect(canonicalCredentialsDockPath('/dev/environment', '')).toBe('/dev/credentials/connections');
    expect(canonicalCredentialsDockPath('/win/hub/api-keys', '')).toBe('/win/hub/credentials/connections');
  });

  it('preserves the query string, which may hold unrelated dock options', () => {
    expect(canonicalCredentialsDockPath('/dock/environment', '?layout=split')).toBe(
      '/dock/credentials/connections?layout=split',
    );
  });

  it('drops a trailing segment — none of the three ever carried a pointer', () => {
    expect(canonicalCredentialsDockPath('/dock/environment/whatever', '')).toBe('/dock/credentials/connections');
  });

  it('leaves everything else alone, including the view that replaced them', () => {
    expect(canonicalCredentialsDockPath('/dock/credentials/connections', '')).toBeNull();
    expect(canonicalCredentialsDockPath('/dock/home', '')).toBeNull();
    expect(canonicalCredentialsDockPath('/dock/hub/worldview/world', '')).toBeNull();
    // Not a dock URL at all.
    expect(canonicalCredentialsDockPath('/environment', '')).toBeNull();
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
