import apiClient from '../client';
import { LMApiProvider } from './lm-providers';

const ACTION = 'lm_keys';

export interface LmApiKeySummary {
  provider: string;
  configured: boolean;
  created_at?: string | null;
}

export interface LmApiKeyValidation {
  valid: boolean;
  message?: string;
}

export interface LmModel {
  id: string;
  name: string;
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

  /** Store a key. The backend auto-validates it and returns the result. */
  setLmApi(key: string, provider: LMApiProvider): Promise<{ ok: true } & LmApiKeyValidation> {
    return apiClient.post(this.base, { provider, key });
  }

  /** Validate the stored key for a provider against the provider (a real network
   *  check). */
  testLmApi(provider: LMApiProvider): Promise<LmApiKeyValidation> {
    return apiClient.post(`${this.base}/test`, { provider });
  }

  /** The provider's model catalog, for the mapping picker. */
  listModels(provider: LMApiProvider): Promise<LmModel[]> {
    return apiClient.get(`${this.base}/models/${encodeURIComponent(provider)}`);
  }

  deleteLmApi(provider: LMApiProvider): Promise<{ ok: true }> {
    return apiClient.delete(`${this.base}/${encodeURIComponent(provider)}`);
  }
}

/** Ready-to-use singleton wired to the local compute node. */
export const lmKeysService = new LmKeysService({ type: 'compute_node', id: '@local' });
