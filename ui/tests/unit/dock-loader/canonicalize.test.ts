/**
 * Step 2 of the loading algorithm (docs/navigation/dock-loading.md): the URL-only
 * rewrites are composed, so every retired spelling reaches its canonical form in
 * ONE redirect, and a canonical URL is left alone.
 */
import contract from '../../../../tests/fixtures/dock_address_contract.json';
import { describe, expect, it } from 'vitest';
import { canonicalizeDockUrl } from '@src/routes/loaders/canonicalize';

const canon = (url: string) => {
  const u = new URL(url, 'http://x');
  return canonicalizeDockUrl(u.pathname, u.search);
};

describe('canonicalizeDockUrl', () => {
  it.each([
    '/dock/display/agentic_process-dddddddd-dddd-4ddd-8ddd-dddddddddddd?viewMode=vibe',
    '/dock/environment',
    '/dock/environment/whatever',
    '/dock/connections',
    '/dock/api-keys',
    '/win/hub/api-keys',
    '/dock/hub/connections',
    '/dock/hub/atlas/organization',
  ])('%s: one redirect, to a URL that is itself canonical', (legacy) => {
    const target = canon(legacy);
    expect(target, `${legacy} was not rewritten`).not.toBeNull();
    expect(canon(target!), `${target} needed a second hop`).toBeNull();
  });

  it('leaves every current URL family of the grammar fixture alone', () => {
    const rewritten = (contract.url_cases as { url: string }[])
      .filter((c) => !c.url.startsWith('/agent/'))
      .map((c) => [c.url, canon(c.url)])
      .filter(([, to]) => to !== null);
    expect(rewritten).toEqual([]);
  });
});
