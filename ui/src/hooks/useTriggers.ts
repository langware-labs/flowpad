import { Trigger } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { QueryRequest } from '@sdk';

const triggerQuery = new QueryRequest({
  type: Trigger.type,
  scope: [],
  name: 'useTriggers:all',
});

/**
 * Every Trigger row, as a live entity query — for a picker of raw triggers (a
 * workflow's trigger node). The Automations screen reads `useAutomations`.
 */
export function useTriggers() {
  const { data: triggers = [], isLoading } = useEntitiesQuery<Trigger>(triggerQuery);
  return { triggers, isLoading };
}
