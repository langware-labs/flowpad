/**
 * `createOrganization` — the org is created on the hub either way; only the
 * transport differs. On a desk runtime the local save is a mirror and `share`
 * publishes it; on the hub the save IS the create, and `share` is a desk-only
 * action the hub answers with `400 Unknown action: share`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  save: vi.fn(),
  share: vi.fn(),
  isHubOnly: vi.fn(),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataManager: { ...(actual.dataManager as object), save: h.save },
    isHubOnly: h.isHubOnly,
  };
});

import { Organization } from '@sdk';

import { createOrganization } from '@src/components/organization/create-organization';

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('createOrganization', () => {
  it('creates the entity with an empty scope, then publishes it from a desk', async () => {
    h.isHubOnly.mockReturnValue(false);
    h.save.mockResolvedValue(undefined);
    const shareSpy = vi.spyOn(Organization.prototype, 'share').mockImplementation(() => h.share());
    h.share.mockResolvedValue(undefined);

    const typeId = await createOrganization('Langware');

    expect(typeId.type).toBe('organization');
    expect(h.save).toHaveBeenCalledWith(typeId, [], expect.objectContaining({ name: 'Langware' }));
    expect(shareSpy).toHaveBeenCalledTimes(1);
  });

  it('does not share on the hub, where the save already created the row', async () => {
    h.isHubOnly.mockReturnValue(true);
    h.save.mockResolvedValue(undefined);
    const shareSpy = vi.spyOn(Organization.prototype, 'share').mockImplementation(() => h.share());

    const typeId = await createOrganization('Langware');

    expect(h.save).toHaveBeenCalledWith(typeId, [], expect.objectContaining({ name: 'Langware' }));
    expect(shareSpy).not.toHaveBeenCalled();
  });
});
