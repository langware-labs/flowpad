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
   * launcher so Python skips its own keyring write (the OS prompt on
   * later launches would not be branded as Flowpad). The key has already
   * been stored in the OS keychain by Electron before this call.
   */
  seedKey(key: string): Promise<{ enabled: boolean }> {
    return apiClient.post(`${this.base}/seed-key`, { key });
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
