import apiClient from '../client';
import { LMApiProvider } from './lm-providers';

const ACTION = 'lm_keys';

export interface LmApiKeySummary {
  provider: string;
  configured: boolean;
  created_at?: string | null;
}

/**
 * SDK service for LLM-provider API keys.
 *
 * Key values are write-only over HTTP. The list endpoint returns which providers
 * are configured — there is no read-by-provider endpoint. In-process callers
 * (workers) read values via the Python `get_lm_api(provider)` SDK function.
 */
export class LmKeysService {
  private readonly base: string;

  constructor(userTypeId: { type: string; id: string }) {
    this.base = `/graph/${userTypeId.type}/${userTypeId.id}/${ACTION}`;
  }

  list(): Promise<LmApiKeySummary[]> {
    return apiClient.get(this.base);
  }

  setLmApi(key: string, provider: LMApiProvider): Promise<{ ok: true }> {
    return apiClient.post(this.base, { provider, key });
  }

  deleteLmApi(provider: LMApiProvider): Promise<{ ok: true }> {
    return apiClient.delete(`${this.base}/${encodeURIComponent(provider)}`);
  }
}

/** Ready-to-use singleton wired to the local compute node. */
export const lmKeysService = new LmKeysService({ type: 'compute_node', id: '@local' });
