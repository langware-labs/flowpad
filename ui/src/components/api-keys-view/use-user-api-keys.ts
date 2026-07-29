import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { ActionInfo, ApiKey, ApiKeyCredentials, dataManager } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

/**
 * The signed-in user's API keys.
 *
 * Always user-scoped — API keys belong to a person, never to a project. That is
 * worth stating because this used to be reached from inside an entity-scoped
 * env-var table, which made the two scopes look like one.
 *
 * Extracted because the same load / generate / delete logic existed twice, in
 * `ApiKeysView` and again inside `EnvVarsManager`, and the two copies had
 * already drifted (one toasted on success, the other did not; one deleted by
 * id, the other by name).
 */

export interface UserApiKeyItem {
  id: string;
  name: string;
  description?: string;
  visible_value: string;
  target_typeid: string;
  expires_at?: string;
  last_used_at?: string;
  is_active: boolean;
}

export interface UseUserApiKeys {
  apiKeys: UserApiKeyItem[];
  /** The active key Flowpad itself authenticates with, if one exists. */
  flowpadKey: UserApiKeyItem | undefined;
  /** Set once by `generate`; the full secret, shown once and never re-fetchable. */
  generatedKey: ApiKeyCredentials | null;
  generate(): Promise<void>;
  remove(keyId: string): Promise<void>;
  reload(): void;
}

const FLOWPAD_KEY_NAME = 'FLOWPAD_API_KEY';

export function useUserApiKeys(opts?: { onMutated?: () => void }): UseUserApiKeys {
  const { t } = useLingui();
  const { user } = useAuth();
  const [apiKeys, setApiKeys] = useState<UserApiKeyItem[]>([]);
  const [generatedKey, setGeneratedKey] = useState<ApiKeyCredentials | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const onMutated = opts?.onMutated;

  useEffect(() => {
    const load = async () => {
      if (!user?.typeId) return;
      try {
        const action = new ActionInfo('api-keys', user.typeId.type, user.typeId.id, 'GET');
        const result = await dataManager.callAction<unknown, UserApiKeyItem[]>(action);
        setApiKeys(result || []);
      } catch (error) {
        console.error('Failed to load API keys:', error);
        setApiKeys([]);
      }
    };
    void load();
  }, [user?.typeId, reloadTick]);

  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  // Derived, not mirrored into state: the previous copies kept a `hasFlowPadApiKey`
  // boolean in sync with this via an effect, which could only ever lag it.
  const flowpadKey = useMemo(
    () => apiKeys.find((k) => k.name?.includes(FLOWPAD_KEY_NAME) && k.is_active),
    [apiKeys],
  );

  const generate = useCallback(async () => {
    if (!user?.typeId) {
      notify.error({ title: t`Error`, message: t`User not found` });
      return;
    }
    try {
      setGeneratedKey(await ApiKey.generateSelfKey(user.typeId));
      reload();
      onMutated?.();
      notify.success({
        title: t`API Key Generated`,
        message: t`Your new API key has been created. Please save it securely.`,
      });
    } catch (error) {
      notify.error({
        title: t`API Key Generation`,
        message: errorMessage(error, t`Failed to generate API key`),
      });
    }
  }, [user?.typeId, reload, onMutated, t]);

  const remove = useCallback(
    async (keyId: string) => {
      if (!user?.typeId) {
        notify.error({ title: t`Error`, message: t`User not found` });
        return;
      }
      try {
        await ApiKey.deleteById(user.typeId, keyId);
        // Optimistic, so the row disappears before the reload lands.
        setApiKeys((prev) => prev.filter((k) => k.id !== keyId));
        setGeneratedKey(null);
        reload();
        onMutated?.();
        notify.success({
          title: t`API Key Deleted`,
          message: t`API key has been removed successfully`,
        });
      } catch (error) {
        notify.error({
          title: t`API Key Deletion`,
          message: errorMessage(error, t`Failed to delete API key`),
        });
      }
    },
    [user?.typeId, reload, onMutated, t],
  );

  return { apiKeys, flowpadKey, generatedKey, generate, remove, reload };
}
