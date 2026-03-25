import {
  CompletionOptions,
  CompletionOptionsEvents,
  dataContext,
  IChatOptionsValues,
  TypeId,
} from '@sdk';
import { useProcess } from '@src/hooks/flow-hooks';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseChatOptionsResult {
  values: IChatOptionsValues;
  onChange: (values: IChatOptionsValues) => void;
}

export function useChatOptions(flowTypeId?: TypeId | null): UseChatOptionsResult {
  // Local state - always exists
  const [localValues, setLocalValues] = useState<IChatOptionsValues>(CompletionOptions.createDefaultValues());

  // Get flow from hook if typeId provided, otherwise use context
  const { data: flowFromHook } = useProcess(flowTypeId ?? null);
  const flow = flowTypeId ? flowFromHook : dataContext.flow;

  // Track if we're syncing to prevent infinite loops
  const isSyncingRef = useRef(false);

  // Sync flow.options → local state when flow options change
  useEffect(() => {
    if (!flow?.options) return;

    const handleFlowChange = () => {
      if (isSyncingRef.current) return;
      isSyncingRef.current = true;
      setLocalValues(flow.options.toValues());
      isSyncingRef.current = false;
    };

    // Initial sync
    handleFlowChange();

    // Listen for changes
    flow.options.on(CompletionOptionsEvents.CHANGE, handleFlowChange);
    return () => {
      flow.options.off(CompletionOptionsEvents.CHANGE, handleFlowChange);
    };
  }, [flow?.options]);

  // onChange handler - updates local state and syncs to flow if available
  const onChange = useCallback(
    (newValues: IChatOptionsValues) => {
      setLocalValues(newValues);

      // Sync to flow if available
      if (flow?.options && !isSyncingRef.current) {
        isSyncingRef.current = true;
        flow.options.applyValues(newValues);
        isSyncingRef.current = false;
      }
    },
    [flow?.options],
  );

  return { values: localValues, onChange };
}
