import { APIEntity, DataManager, FlowMessage, registerEntity } from '@sdk';
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

  it('clears a message\'s missing attachments once its body downloads', () => {
    // The pre-download payload lists every entity as missing; the post-unpack
    // UPDATE lists none. Merging by index kept the old entry beside
    // body_downloaded=true, which the bubble reads as "pulled, but arrived short".
    const manager = new DataManager<FlowMessage>();
    const id = '161f1f5e-8e4a-49d0-a268-d40b44d1e050';
    manager.updateEntityFromJson<FlowMessage>({
      type: FlowMessage.type,
      id,
      body_status: 'uploading',
      body_downloaded: false,
      body_missing_attachments: [
        { attachment_type: 'type_id', data: 'flowpad_diagnosis-a4c10701-8366-4f6b-badf-21c8273a3016' },
      ],
    });

    const downloaded = manager.updateEntityFromJson<FlowMessage>({
      type: FlowMessage.type,
      id,
      body_status: 'ready',
      body_downloaded: true,
      body_missing_attachments: [],
    });

    expect(downloaded.body_downloaded).toBe(true);
    expect(downloaded.body_missing_attachments).toEqual([]);
  });
});
