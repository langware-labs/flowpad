/**
 * `createOrganization` — create the entity locally, then publish it to the hub.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  save: vi.fn(),
  share: vi.fn(),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataManager: { ...(actual.dataManager as object), save: h.save },
  };
});

import { Organization } from '@sdk';

import { createOrganization } from '@src/components/organization/create-organization';

afterEach(() => {
  vi.clearAllMocks();
});

describe('createOrganization', () => {
  it('creates the entity with an empty scope, then shares it', async () => {
    h.save.mockResolvedValue(undefined);
    const shareSpy = vi.spyOn(Organization.prototype, 'share').mockImplementation(() => h.share());
    h.share.mockResolvedValue(undefined);

    const typeId = await createOrganization('Langware');

    expect(typeId.type).toBe('organization');
    expect(h.save).toHaveBeenCalledWith(typeId, [], expect.objectContaining({ name: 'Langware' }));
    expect(shareSpy).toHaveBeenCalledTimes(1);
  });
});
