import apiClient from '../client';

const ACTION = 'secrets';

export interface AppSecretSummary {
  name: string;
  description?: string;
  created_at?: string | null;
}

/**
 * SDK service for app-secrets management.
 *
 * Secret values are write-only over HTTP. The list endpoint returns
 * name + description + created_at only — there is no read-by-name endpoint.
 * In-process callers (flows, agents) read values via the Python
 * `read_secret(name)` SDK function.
 */
export class SecretsService {
  private readonly base: string;

  constructor(userTypeId: { type: string; id: string }) {
    this.base = `/graph/${userTypeId.type}/${userTypeId.id}/${ACTION}`;
  }

  isEnabled(): Promise<{ enabled: boolean }> {
    return apiClient.get(`${this.base}/is-enabled`);
  }

  enable(): Promise<{ enabled: boolean }> {
    return apiClient.post(`${this.base}/enable`);
  }

  /**
   * Hand a pre-minted Fernet key to Python. Used by the signed Electron
   * launcher so Python skips its own keyring write — the OS keychain entry
   * is created by the bundled flow-rs binary (Langware-signed), so its ACL
   * trust list shows flow-rs rather than the unsigned uv-bundled python3.x.
   */
  seedKey(key: string): Promise<{ enabled: boolean }> {
    return apiClient.post(`${this.base}/seed-key`, { key });
  }

  /**
   * One-shot legacy migration: returns the Fernet key value currently
   * stored at the legacy bare-instance keychain slot (python3.x-owned),
   * or { key: null } if no legacy entry exists. The renderer hands the
   * value to electronAPI.provisionSodKey(value), which re-writes it via
   * flow-rs at the .flow-rs slot — moving ACL ownership to flow-rs
   * without losing the sodot's encryption key. Sibling: cleanupLegacy().
   */
  migrateToFlowRs(): Promise<{ key: string | null; has_legacy: boolean }> {
    return apiClient.post(`${this.base}/migrate-to-flow-rs`);
  }

  /** Delete the legacy bare-instance keychain entry. Call after a
   *  successful migrateToFlowRs + provisionSodKey + seedKey round-trip. */
  cleanupLegacy(): Promise<{ ok: boolean }> {
    return apiClient.post(`${this.base}/cleanup-legacy`);
  }

  list(): Promise<AppSecretSummary[]> {
    return apiClient.get(this.base);
  }

  write(name: string, value: string, description?: string): Promise<{ ok: true }> {
    return apiClient.post(this.base, { name, value, description });
  }

  delete(name: string): Promise<{ ok: true }> {
    return apiClient.delete(`${this.base}/${encodeURIComponent(name)}`);
  }
}

/** Ready-to-use singleton wired to the local compute node. */
export const secretsService = new SecretsService({ type: 'compute_node', id: '@local' });
