import { FlowPadApiKeyPanel, GeneratedApiKeyCallout } from '@src/components/api-keys-view/FlowPadApiKeyPanel';
import { useUserApiKeys } from '@src/components/api-keys-view/use-user-api-keys';
import { TypeId } from '@sdk';
import { useEntityEnvMutations } from '@sdk/react/hooks';
import React, { useCallback } from 'react';

/**
 * The USER's FlowPad API key, beneath the desk Environment tab's ENTITY-scoped
 * table.
 *
 * The two scopes used to be fused inside `EnvVarsManager`, which meant every
 * mount of the env table fetched user API keys — including the mounts that
 * never render them. Composing them here keeps the legacy layout and confines
 * both the fetch and the scope mismatch to the one surface that wants it.
 *
 * Generating or deleting a key writes an env var on the entity, so the table
 * has to be invalidated.
 */
export const DeskEnvApiKeyPanel: React.FC<{ entityTypeId: TypeId }> = ({ entityTypeId }) => {
  const envMutations = useEntityEnvMutations(entityTypeId);
  // Stable across renders (the hook memoizes on the TypeId), so the key
  // mutations don't get rebuilt on every keystroke elsewhere on the tab.
  const onMutated = useCallback(() => envMutations.invalidate(), [envMutations]);
  const keys = useUserApiKeys({ onMutated });

  return (
    <>
      <FlowPadApiKeyPanel keys={keys} className="mt-6" />
      {keys.generatedKey && <GeneratedApiKeyCallout apiKey={keys.generatedKey} className="mt-6" />}
    </>
  );
};
