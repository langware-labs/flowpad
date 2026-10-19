import { agentCounterGroup } from './agent-counters';
import { appCounterGroup } from './app-counters';
import type { AssetCounterGroup } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GROUPS: Record<string, AssetCounterGroup<any>> = {
  [agentCounterGroup.id]: agentCounterGroup,
  [appCounterGroup.id]: appCounterGroup,
};

export function findCounterGroup(id: string | undefined) {
  return id ? GROUPS[id] : undefined;
}
