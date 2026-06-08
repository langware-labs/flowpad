/**
 * Provisions OS-keychain-backed secrets for the current install and resolves
 * with whether it succeeded. Runs silently — there is no in-app dialog; the
 * OS keychain prompt (which the app cannot suppress) is the only user-visible
 * interaction.
 *
 * Under signed Electron the Fernet key is minted + stored in the OS keychain
 * via the bundled flow-rs binary and seeded into Python via /secrets/seed-key,
 * so the keychain ACL trust list lists flow-rs rather than the unsigned
 * uv-bundled python3.x. Plain web/CLI falls back to Python's keyring write via
 * /secrets/enable.
 */
import { secretsService } from './secrets-service';

export const secretApprovalGate = {
  /** Provision keychain-backed secrets; resolves true on success. */
  async request(): Promise<boolean> {
    try {
      const provisionSodKey = (globalThis as unknown as {
        electronAPI?: { provisionSodKey?: () => Promise<string> };
      }).electronAPI?.provisionSodKey;

      const result = provisionSodKey
        ? await secretsService.seedKey(await provisionSodKey())
        : await secretsService.enable();

      return Boolean(result?.enabled);
    } catch {
      return false;
    }
  },
};
