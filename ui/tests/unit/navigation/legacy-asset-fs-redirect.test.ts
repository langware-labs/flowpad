import { Layout, PageId } from '@sdk';
import { describe, expect, it } from 'vitest';

import { DockPointer } from '@src/navigation/DockPointer';
import { redirectLegacyAssetFsDock } from '@src/routes/loaders/main-loader';
import { ViewType } from '@src/types/ViewType';

function captureRedirect(dock: DockPointer, requestPath: string): Response | null {
  try {
    redirectLegacyAssetFsDock(dock, requestPath);
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  return null;
}

describe('legacy Assets fs route canonicalization', () => {
  it('replace-redirects a relative route to canonical local VFS identity', () => {
    const redirect = captureRedirect(
      new DockPointer(ViewType.ASSETS, 'fs/Users/shlom/docs', { editorMode: 'view' }),
      '/dock/assets/fs/Users/shlom/docs',
    );

    expect(redirect?.status).toBe(302);
    expect(redirect?.headers.get('Location')).toBe(
      '/dock/assets/fs/vfs/compute_node-%40local/Users/shlom/docs?editorMode=view',
    );
  });

  it('preserves project rebase, layout, page, and options', () => {
    const dock = new DockPointer(
      ViewType.PROJECT,
      'project-id/fs/docs/agent',
      { viewMode: 'advanced' },
      Layout.WIN,
      PageId.HUB,
    );
    const redirect = captureRedirect(dock, '/win/hub/project/project-id/fs/docs/agent');

    expect(redirect?.headers.get('Location')).toBe(
      '/win/hub/project/project-id/fs/vfs/compute_node-%40local/docs/agent?viewMode=advanced',
    );
  });

  it('does not redirect an already-canonical route', () => {
    const dock = new DockPointer(
      ViewType.ASSETS,
      'fs/vfs/compute_node-@local/Users/shlom/docs',
    );
    expect(captureRedirect(dock, dock.toUrl())).toBeNull();
  });
});
