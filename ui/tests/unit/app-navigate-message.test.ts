// A guest app asks the host to open a dock; only a `/dock/` address that parses is honoured.
import { describe, expect, it } from 'vitest';

import { guestNavigation } from '@src/pages/flow-page/app-display-viewer';

describe('flowpad:navigate', () => {
  it('opens a dock address — another app, on its subject', () => {
    const app = 'micro_app-0b6f3d6e-8a8e-4a43-9d3b-6f1f2c9a4e11';
    const dock = guestNavigation({ type: 'flowpad:navigate', address: `/dock/app/${app}?subject=dataset-1` });
    expect(dock?.toUrl()).toContain(`/dock/app/${app}`);
    expect(dock?.toUrl()).toContain('subject=dataset-1');
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
