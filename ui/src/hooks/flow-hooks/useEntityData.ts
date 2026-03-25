/**
 * useEntityData React Hook
 *
 * Subscribes to FlowData for an entity by TypeId.
 * Listens to the entity's flowDataStream which receives WebSocket FlowData.
 *
 * @example
 * ```tsx
 * const { flowData, isComplete, count } = useEntityData(process.typeId);
 *
 * return (
 *   <div>
 *     {flowData.map((fd, i) => (
 *       <div key={i}>[{fd.elementType}] {fd.data}</div>
 *     ))}
 *   </div>
 * );
 * ```
 */

import { useCallback, useEffect, useState } from 'react';
import { dataManager, FlowData, TypeId } from '@sdk';

export interface UseEntityDataResult {
  /** All FlowData items received so far */
  flowData: readonly FlowData[];
  /** Whether the stream is complete */
  isComplete: boolean;
  /** Number of FlowData items */
  count: number;
  /** Clear all collected FlowData */
  clear: () => void;
}

/**
 * React hook to subscribe to FlowData for an entity.
 *
 * @param entityTypeId - TypeId of the entity to listen to
 * @returns FlowData array and stream state
 */
export function useEntityData(entityTypeId: TypeId | null | undefined): UseEntityDataResult {
  const [flowData, setFlowData] = useState<readonly FlowData[]>([]);
  const [isComplete, setIsComplete] = useState(false);

  const clear = useCallback(() => {
    setFlowData([]);
    setIsComplete(false);
  }, []);

  useEffect(() => {
    // Clear state when entityTypeId becomes null/undefined
    if (!entityTypeId) {
      setFlowData([]);
      setIsComplete(false);
      return;
    }

    // Get entity from cache
    const entity = dataManager.getByTypeIdFromCache(entityTypeId);
    if (!entity) {
      console.warn(`[useEntityData] Entity not found in cache for typeId: ${entityTypeId.toString()}`);
      setFlowData([]);
      setIsComplete(false);
      return;
    }

    // Check if entity has flowDataStream (APIEntity)
    if (!('flowDataStream' in entity)) {
      console.warn(`[useEntityData] Entity does not have flowDataStream: ${entityTypeId.toString()}`);
      setFlowData([]);
      setIsComplete(false);
      return;
    }

    const apiEntity = entity as {
      flowDataStream: { items: readonly FlowData[]; isComplete: boolean };
      loadHistory?: (options?: { force?: boolean; onlyUserMessages?: boolean }) => Promise<void>;
      historyLoaded?: boolean;
    };

    // Initialize with existing data
    setFlowData(apiEntity.flowDataStream.items);
    setIsComplete(apiEntity.flowDataStream.isComplete);

    // If the stream is empty, attempt to load history (agentic processes emit user prompts early).
    // Do not auto-load history here; streaming should be reliable once watch is established.

    // Subscribe to new FlowData
    const handleFlowData = (_data: FlowData) => {
      // Re-read from stream to get all items (including any we might have missed)
      setFlowData([...apiEntity.flowDataStream.items]);
    };

    // Subscribe to completion
    const handleComplete = () => {
      setIsComplete(true);
      // Final update to ensure we have all data
      setFlowData([...apiEntity.flowDataStream.items]);
    };

    // Use entity's event system
    const unsubData = (entity as any).on('flow_data', handleFlowData);
    const unsubComplete = (entity as any).on('complete', handleComplete);

    return () => {
      unsubData?.();
      unsubComplete?.();
    };
  }, [entityTypeId?.toString()]);

  return {
    flowData,
    isComplete,
    count: flowData.length,
    clear,
  };
}
