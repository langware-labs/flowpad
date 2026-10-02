import apiClient from '../client';
import type { StatusRecord } from '../entities/status-record';
import { lazyAssets } from '../lazy/registry';
import { LazyAsset } from '../lazy/LazyAsset';

/**
 * The status record, read from the backend that owns every fact in it.
 *
 * `fetch` is a pure read. `refresh` is the ONE verb that re-discovers CLIs and re-probes
 * their logins; nothing else in the UI probes.
 */
export class StatusService {
  private readonly base: string;

  constructor(private readonly nodeTypeId: { type: string; id: string }) {
    this.base = `/graph/${nodeTypeId.type}/${nodeTypeId.id}/status`;
  }

  fetch(): Promise<StatusRecord> {
    return apiClient.get<StatusRecord>(this.base);
  }

  /** The record through the shared cache, or `null` where there is no box to ask (the hub). */
  record(): Promise<StatusRecord | null> {
    return lazyAssets.load(LazyAsset.Status, { nodeTypeId: this.nodeTypeId });
  }

  /** Re-discover the given capability kinds (all when omitted) and re-probe their logins. The
   *  backend pushes `status_changed_msg` afterwards, so every cached reader follows. */
  refresh(kinds?: string[]): Promise<StatusRecord> {
    return apiClient.post<StatusRecord>(`${this.base}/refresh`, kinds ? { kinds } : {});
  }
}

export const statusService = new StatusService({ type: 'compute_node', id: '@local' });
