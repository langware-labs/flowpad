/**
 * One-shot legacy keychain migration: python3.x → flow-rs.
 *
 * Runs once per session (guarded by a ref) when the renderer detects it's
 * inside signed Electron. Orchestrates the read-rewrite-cleanup handoff:
 *
 *   1. /secrets/migrate-to-flow-rs  → backend returns the Fernet value
 *      currently stored at (Flowpad.ai.sod_key, <instance>) — the legacy
 *      python3.x-owned slot. Python reads its own entry, no prompt.
 *   2. electronAPI.provisionSodKey(value) → main.js IPC handler hands the
 *      value to flow-rs setKeyRestricted at the <instance>.flow-rs slot.
 *      The new entry's ACL trust list shows flow-rs (signed) instead of
 *      python3.x.
 *   3. /secrets/seed-key → populates the running backend's in-process
 *      _sod_key_memo so existing sod operations keep working without
 *      re-reading the keychain.
 *   4. /secrets/cleanup-legacy → deletes the old python3.x-owned entry.
 *
 * Preserves the user's secrets: the sodot file's encryption key is
 * unchanged across the migration (same Fernet value, just a different
 * keychain ACL owner).
 *
 * No-op when:
 *   - Not running in Electron (window.electronAPI absent / no provisionSodKey).
 *   - Legacy slot is empty (fresh install or already migrated).
 */
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { secretsService } from '@sdk';

const MigrateLegacyKeychain = () => {
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    const provisionSodKey = (window as unknown as {
      electronAPI?: { provisionSodKey?: (existingValue?: string) => Promise<string> };
    }).electronAPI?.provisionSodKey;

    if (!provisionSodKey) return; // web / CLI — nothing to migrate

    void (async () => {
      try {
        const { key, has_legacy } = await secretsService.migrateToFlowRs();
        if (!has_legacy || !key) return; // nothing to migrate

        await provisionSodKey(key);          // flow-rs writes at .flow-rs slot
        await secretsService.seedKey(key);   // populate running backend's memo
        await secretsService.cleanupLegacy(); // delete python3.x entry
        toast.success('Keychain migrated to signed Flowpad');
      } catch (err) {
        // Migration is best-effort. If anything fails, leave the legacy
        // entry intact and let the existing python3.x flow keep working.
        // eslint-disable-next-line no-console
        console.warn('[migrate-legacy-keychain] migration skipped:', err);
      }
    })();
  }, []);

  return null;
};

export default MigrateLegacyKeychain;
