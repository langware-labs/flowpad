import { APIEntity, DataManager, registerEntity } from '@sdk';
import { describe, expect, it } from 'vitest';

class CollisionCacheEntity extends APIEntity<CollisionCacheEntity> {
  static type = 'collision_cache_test';
}

registerEntity(CollisionCacheEntity);

describe('asset occurrence cache projection', () => {
  it('replaces the complete occurrence array when a websocket update shrinks it', () => {
    const manager = new DataManager<CollisionCacheEntity>();
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const initial = manager.updateEntityFromJson<CollisionCacheEntity>({
      type: CollisionCacheEntity.type,
      id,
      duplicate_count: 2,
      asset_occurrences: [
        { path: '/repo/primary.md', first_seen_at: '2026-07-18T09:00:00Z' },
        { path: '/repo/copy-a.md', first_seen_at: '2026-07-19T09:00:00Z' },
        { path: '/repo/copy-b.md', first_seen_at: '2026-07-20T09:00:00Z' },
      ],
    });

    const updated = manager.updateEntityFromJson<CollisionCacheEntity>({
      type: CollisionCacheEntity.type,
      id,
      duplicate_count: 1,
      asset_occurrences: [
        { path: '/repo/primary.md', first_seen_at: '2026-07-18T09:00:00Z' },
        { path: '/repo/copy-a.md', first_seen_at: '2026-07-19T09:00:00Z' },
      ],
    });

    expect(updated).toBe(initial);
    expect(updated.duplicate_count).toBe(1);
    expect(updated.asset_occurrences?.map((occurrence) => occurrence.path)).toEqual([
      '/repo/primary.md',
      '/repo/copy-a.md',
    ]);
  });
});
