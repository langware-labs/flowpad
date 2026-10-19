import { LazyAsset } from '@sdk/lazy';
import { useLazyAsset } from '@sdk/react/hooks/useLazyAsset';
import { type TypeId } from '@sdk';

export const CONNECTIONS_KEY = ['lazy', LazyAsset.Connections] as const;

/**
 * Every connection this box has, as one cached read.
 *
 * One request where the screen used to make eight — and, more to the point, one
 * definition of "connected". Folding four shapes in the browser is what let the
 * Connections table and the LLM sources screen disagree about the same key.
 *
 * `null` means the hub: device logins, stored keys and OAuth grants are box
 * facts, so the action does not exist there and the caller renders nothing
 * rather than an empty-looking box.
 */
export function useConnections(projectTypeId?: TypeId | null) {
  const projectId = projectTypeId?.id ?? '';
  const { data, isLoading, reload: refetch } = useLazyAsset(LazyAsset.Connections, { projectId: projectId || undefined });
  return { connections: data ?? null, isLoading, refetch };
}
