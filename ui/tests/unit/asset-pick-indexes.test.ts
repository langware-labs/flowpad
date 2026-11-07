/**
 * The asset list is a read-only disk scan, so it can offer an asset nobody indexed yet: an id with no row.
 * A message cannot carry that ("Cannot send: … there is no local record of it"). Picking it indexes its path
 * and hands on the id the indexer answers; an asset that already has a row is handed on as picked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataManager } from '@sdk';
import apiClient from '@sdk/client';
import { indexedForSending } from '@src/components/asset-manager/AssetManagerPopover';

afterEach(() => vi.restoreAllMocks());

const picked = {
  typeid: 'skill-a96b2c71-96d1-5780-bf71-403b8c6300c9',
  source: 'worker',
  posix_path: '/w/.claude/skills/probe',
} as never;

describe('indexedForSending', () => {
  it('indexes an unindexed asset by its path and hands on the indexed id', async () => {
    vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue(null as never);
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ typeids: ['skill-40172647-6cd7-4f16-8d38-78c658658bf5'] } as never);

    const out = await indexedForSending(picked);

    expect(out.typeid).toBe('skill-40172647-6cd7-4f16-8d38-78c658658bf5');
    expect(String(post.mock.calls[0][0])).toContain('fs-records/index?path=%2Fw%2F.claude%2Fskills%2Fprobe&type=skill');
  });

  it('hands on an asset that already has a row, untouched', async () => {
    vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue({ id: 'x' } as never);
    const post = vi.spyOn(apiClient, 'post');

    expect(await indexedForSending(picked)).toBe(picked);
    expect(post).not.toHaveBeenCalled();
  });
});
