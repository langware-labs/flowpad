import { Flow, FlowStateProperty, IChatOptions, IFlowState, TypeId } from '@sdk';
import { useMemo } from 'react';
import { useProcessStateField } from './useProcessStateField';

/**
 * Hook for accessing chat options from flow state (backend state)
 * Uses useProcessStateField internally to subscribe to chat_options changes
 * @param flow - The flow entity to track
 * @returns The chat options state or null if not available
 */
export function useStateChatOptions(flow: Flow | null | undefined): IChatOptions | null {
  const flowTypeId = useMemo(() => (flow ? new TypeId(Flow.type, flow.id) : null), [flow]);
  const { state }: { state: IChatOptions | null } = useProcessStateField<keyof IFlowState>(
    flowTypeId,
    FlowStateProperty.CHAT_OPTIONS,
  );
  return state;
}
