/**
 * The project page asks for the invite roles (`GET share-roles`). The hub has no such
 * route and answered 422 on every project page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataManager, membershipService, setSupportedPagesForHubMode } from '@sdk';

describe('the invite roles', () => {
  afterEach(() => {
    setSupportedPagesForHubMode(['desk', 'hub']);
    vi.restoreAllMocks();
  });

  it('are not asked of the hub', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue(['member'] as never);
    setSupportedPagesForHubMode(['hub']);

    expect(await membershipService.fetchShareRoles()).toEqual(['admin', 'editor', 'reader', 'runner']);
    expect(call).not.toHaveBeenCalled();
  });

  it('use the generated registry on the desktop too', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue(['member', 'admin'] as never);
    setSupportedPagesForHubMode(['desk', 'hub']);

    expect(await membershipService.fetchShareRoles()).toEqual(['admin', 'editor', 'reader', 'runner']);
    expect(call).not.toHaveBeenCalled();
  });
});
