import apiClient from '../client';
import { isHubOnly } from '../utils/hub-runtime';
import { LMApiProvider } from './lm-providers';

const ACTION = 'lm_keys';

export interface LmApiKeySummary {
  provider: string;
  configured: boolean;
  created_at?: string | null;
  /** True for a provider the user cannot key by hand (the FlowPad hub endpoint,
   *  bound by the hub and authenticated by the box's hub login). */
  managed?: boolean;
  /** Human-readable detail for a managed row (the endpoint typeid). */
  detail?: string | null;
  /** The bound endpoint's display name (managed rows only). */
  name?: string | null;
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
/** What `saveEndpoint` may set on a local endpoint row (`LLMEndpointConfig` on the backend). */
export interface LocalEndpointConfig {
  name?: string;
  base_url?: string;
  tiers?: Record<string, string>;
  limits?: Record<string, number | null>;
  filters?: Record<string, unknown>;
}

/** A device login's endpoint row as `GET lm_keys/device` returns it (`LLMEndpoint.to_wire`). */
export interface DeviceEndpointWire {
  id: string;
  name: string;
  kind: 'device';
  harness: string;
  /** Sizes (`sm`/`md`/`lg`) and custom names (any other key) → model. */
  tiers: Record<string, string>;
  invocable: false;
}

export class LmKeysService {
  private readonly base: string;

  constructor(userTypeId: { type: string; id: string }) {
    this.base = `/graph/${userTypeId.type}/${userTypeId.id}/${ACTION}`;
  }

  list(): Promise<LmApiKeySummary[]> {
    // Hub mode: LM keys live on the local compute node (`compute_node/@local`),
    // which the hub backend does not have. Report none configured.
    if (isHubOnly()) return Promise.resolve([]);
    return apiClient.get(this.base);
  }

  /** Store a key. The backend auto-validates it and returns the result. */
  setLmApi(key: string, provider: LMApiProvider): Promise<{ ok: true } & LmApiKeyValidation> {
    return apiClient.post(this.base, { provider, key });
  }

  /** Create or edit this machine's endpoint for a provider: store `key` (validated on store) and/or
   *  write the row's fields. The same fields the hub page writes on a hub root. */
  saveEndpoint(
    provider: LMApiProvider,
    body: { key?: string; config?: LocalEndpointConfig },
  ): Promise<{ ok: true; endpoint_id: string } & Partial<LmApiKeyValidation>> {
    return apiClient.post(this.base, { provider, ...body });
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

  /** One endpoint row per device-login harness (claude / codex / copilot subscriptions): no key,
   *  only the model sizes and custom named models the user set on it (`kind: device`). */
  listDeviceEndpoints(): Promise<DeviceEndpointWire[]> {
    if (isHubOnly()) return Promise.resolve([]);
    return apiClient.get(`${this.base}/device`);
  }

  /** Replace a device login's sizes and custom names (an empty value clears that entry). */
  saveDeviceEndpoint(
    harness: string,
    config: { tiers: Record<string, string | null>; name?: string },
  ): Promise<{ ok: true; endpoint_id: string }> {
    return apiClient.post(`${this.base}/device`, { harness, config });
  }

  deleteLmApi(provider: LMApiProvider): Promise<{ ok: true }> {
    return apiClient.delete(`${this.base}/${encodeURIComponent(provider)}`);
  }
}

/** Ready-to-use singleton wired to the local compute node. */
export const lmKeysService = new LmKeysService({ type: 'compute_node', id: '@local' });
