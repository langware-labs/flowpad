import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  entity: null as null | { name: string; dirty: boolean },
  save: vi.fn(),
}));

vi.mock('@sdk', () => ({
  dataManager: { getByTypeIdFromCache: () => h.entity, save: (...a: unknown[]) => h.save(...a) },
}));

import { renameEntity } from '@src/components/organization/budgets/rename-entity';

const typeId = { type: 'team', id: '270d0fbb-a54f-4170-b898-c70e0e97a138' } as never;

describe('renameEntity', () => {
  beforeEach(() => {
    h.entity = { name: 'old', dirty: false };
    h.save.mockReset();
  });

  it('shows the new name before the save has answered', async () => {
    let finish!: () => void;
    h.save.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));

    const done = renameEntity(typeId, 'new');
    expect(h.entity?.name).toBe('new'); // while the PUT is still in flight
    finish();
    await done;
    expect(h.entity?.name).toBe('new');
  });

  it('writes only the name, never the whole entity', async () => {
    h.save.mockResolvedValue(undefined);
    await renameEntity(typeId, 'new');
    expect(h.save).toHaveBeenCalledWith(typeId, [], { name: 'new' });
  });

  it('puts the old name back when the save fails, and still raises the error', async () => {
    h.save.mockRejectedValue(new Error('403'));
    await expect(renameEntity(typeId, 'new')).rejects.toThrow('403');
    expect(h.entity).toMatchObject({ name: 'old', dirty: false });
  });

  it('leaves a newer name alone when the save fails after the server moved on', async () => {
    h.save.mockImplementation(() => {
      if (h.entity) h.entity.name = 'set by someone else'; // a push that arrived while we waited
      return Promise.reject(new Error('boom'));
    });
    await expect(renameEntity(typeId, 'new')).rejects.toThrow('boom');
    expect(h.entity?.name).toBe('set by someone else');
  });

  it('still saves when the entity is not cached', async () => {
    h.entity = null;
    h.save.mockResolvedValue(undefined);
    await expect(renameEntity(typeId, 'new')).resolves.toBeUndefined();
    expect(h.save).toHaveBeenCalledOnce();
  });
});
