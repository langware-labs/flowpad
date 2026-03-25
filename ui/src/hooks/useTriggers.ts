import { Trigger } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { QueryRequest } from '@sdk';

const triggerQuery = new QueryRequest({
  type: Trigger.type,
  scope: [],
  name: 'useTriggers:all',
});

/**
 * Returns all Trigger entities from the SDK cache.
 * The loader prefetches via Trigger.query() so this hook reads without a
 * second network round-trip.
 */
export function useTriggers() {
  const { data: triggers = [], isLoading } = useEntitiesQuery<Trigger>(triggerQuery);
  return { triggers, isLoading };
}
