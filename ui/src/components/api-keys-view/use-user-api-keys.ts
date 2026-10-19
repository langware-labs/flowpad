import { useCallback, useMemo, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { ActionInfo, ApiKey, ApiKeyCredentials } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { useAction } from '@src/hooks/use-action';
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
  /**
   * Takes the key, not an identifier: the hub revokes by name while `UserApiKeyItem`
   * carries both `id` and `name`, and passing the id fails silently (the button
   * appears to do nothing). Handing over the whole row makes that a type error.
   */
  remove(key: Pick<UserApiKeyItem, 'name'>): Promise<void>;
}

const FLOWPAD_KEY_NAME = 'FLOWPAD_API_KEY';

export function useUserApiKeys(opts?: { onMutated?: () => void }): UseUserApiKeys {
  const { t } = useLingui();
  const { user } = useAuth();
  const [generatedKey, setGeneratedKey] = useState<ApiKeyCredentials | null>(null);
  const onMutated = opts?.onMutated;

  // `useAction` rather than a hand-rolled effect: it aborts the in-flight
  // request and guards the sequence, so switching user mid-flight can't land a
  // stale key list, and its `refetch` replaces the reload counter.
  const action = useMemo(
    () => (user?.typeId ? new ActionInfo('api-keys', user.typeId.type, user.typeId.id, 'GET') : null),
    [user?.typeId],
  );
  const { data, refetch } = useAction<UserApiKeyItem[]>(action);
  const apiKeys = useMemo(() => data ?? [], [data]);

  const reload = useCallback(() => void refetch(), [refetch]);

  // Derived, not mirrored into state: the previous copies kept a `hasFlowPadApiKey`
  // boolean in sync with this via an effect, which could only ever lag it.
  const flowpadKey = useMemo(() => apiKeys.find((k) => k.name?.includes(FLOWPAD_KEY_NAME) && k.is_active), [apiKeys]);

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
    async (key: Pick<UserApiKeyItem, 'name'>) => {
      if (!user?.typeId) {
        notify.error({ title: t`Error`, message: t`User not found` });
        return;
      }
      try {
        await ApiKey.deleteByName(user.typeId, key.name);
        // No optimistic removal: the backend soft-deletes, so the row comes
        // back as Inactive rather than vanishing. Dropping it here would make
        // it disappear and then reappear when the reload lands.
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

  return useMemo(
    () => ({ apiKeys, flowpadKey, generatedKey, generate, remove }),
    [apiKeys, flowpadKey, generatedKey, generate, remove],
  );
}
