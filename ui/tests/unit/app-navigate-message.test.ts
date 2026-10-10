// A guest app asks the host to open a dock; only a `/dock/` address that parses is honoured.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OPEN_EXTERNAL_MESSAGE, externalUrl, openExternal } from '@sdk/apps/host';
import { guestExternalUrl, guestNavigation } from '@src/pages/flow-page/app-display-viewer';

describe('flowpad:navigate', () => {
  it('opens a dock address — another app, on its subject', () => {
    const app = 'micro_app-0b6f3d6e-8a8e-4a43-9d3b-6f1f2c9a4e11';
    const dock = guestNavigation({ type: 'flowpad:navigate', address: `/dock/app/${app}?subject=dataset-1` });
    expect(dock?.toUrl()).toContain(`/dock/app/${app}`);
    expect(dock?.toUrl()).toContain('subject=dataset-1');
  });

  it('opens an entity where its type lives — a project to its home', () => {
    const project = 'project-6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
    expect(guestNavigation({ type: 'flowpad:navigate', typeid: project })?.toUrl()).toContain('6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b');
    expect(guestNavigation({ type: 'flowpad:navigate', typeid: 'not a typeid' })).toBeNull();
  });

  it.each([
    ['another message type', { type: 'flowpad:theme', address: '/dock/home' }],
    ['a non-dock URL', { type: 'flowpad:navigate', address: 'https://evil.example/dock/home' }],
    ['a relative path outside /dock', { type: 'flowpad:navigate', address: '/settings' }],
    ['no address', { type: 'flowpad:navigate' }],
    ['nothing', null],
  ])('ignores %s', (_why, data) => {
    expect(guestNavigation(data)).toBeNull();
  });
});

// A guest app asks the host to open an OUTSIDE page (a record in a CRM): only an absolute http(s) address.
describe('flowpad:open-external', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the host opens an http(s) address a guest asks for', () => {
    expect(guestExternalUrl({ type: 'flowpad:open-external', url: 'https://crm.example.com/object/opportunity/42' })).toBe(
      'https://crm.example.com/object/opportunity/42',
    );
    expect(guestExternalUrl({ type: OPEN_EXTERNAL_MESSAGE, url: 'http://localhost:3000/x?y=1' })).toBe('http://localhost:3000/x?y=1');
  });

  it.each([
    ['a script address', { type: 'flowpad:open-external', url: 'javascript:alert(1)' }],
    ['a file', { type: 'flowpad:open-external', url: 'file:///etc/passwd' }],
    ['a relative path', { type: 'flowpad:open-external', url: '/dock/home' }],
    ['a data address', { type: 'flowpad:open-external', url: 'data:text/html,<b>x</b>' }],
    ['no url', { type: 'flowpad:open-external' }],
    ['a url that is not text', { type: 'flowpad:open-external', url: { href: 'https://x.example' } }],
    ['another message type', { type: 'flowpad:navigate', url: 'https://x.example' }],
    ['nothing', null],
  ])('the host ignores %s', (_why, data) => {
    expect(guestExternalUrl(data)).toBeNull();
  });

  it('a navigate message is not an open-external one, and the reverse', () => {
    expect(guestNavigation({ type: 'flowpad:open-external', url: 'https://x.example' })).toBeNull();
  });

  it('the app side posts the message the host reads, to its parent', () => {
    const post = vi.fn();
    vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage: post } as never);
    openExternal('https://crm.example.com/object/42');
    expect(post).toHaveBeenCalledWith({ type: OPEN_EXTERNAL_MESSAGE, url: 'https://crm.example.com/object/42' }, '*');
    expect(guestExternalUrl(post.mock.calls[0][0])).toBe('https://crm.example.com/object/42');   // what one sends, the other opens
  });

  it('an app shown on its own opens a new tab itself', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openExternal('https://crm.example.com/a');
    expect(open).toHaveBeenCalledWith('https://crm.example.com/a', '_blank', 'noopener,noreferrer');
  });

  it('the app side refuses anything that is not an absolute http(s) address', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(() => openExternal('javascript:alert(1)')).toThrow(/absolute http\(s\) address/);
    expect(() => openExternal('/relative')).toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(externalUrl(7)).toBeNull();
  });
});
