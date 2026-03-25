import { ActionInfo, Flow, FlowCheckpointItem, FlowStateProperty, TypeId, dataManager } from '@sdk';
import { useCallback, useMemo } from 'react';
import { useProcessStateField } from './useProcessStateField';

export interface CheckpointInfo {
  checkpointHash: string;
  timestamp: Date;
  index: number;
  timeAgo: string;
}

/**
 * Parse checkpoint hash from XML message
 * Example: '<flow-checkpoint checkpoint_hash="abc123"/>'
 */
function parseCheckpointHash(message: string): string | null {
  const match = message.match(/checkpoint_hash="([^"]+)"/);
  return match ? match[1] : null;
}

/**
 * Format time ago string (e.g., "2 minutes ago", "1 hour ago")
 */
function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffDay > 0) return `${diffDay} day${diffDay > 1 ? 's' : ''} ago`;
  if (diffHour > 0) return `${diffHour} hour${diffHour > 1 ? 's' : ''} ago`;
  if (diffMin > 0) return `${diffMin} min${diffMin > 1 ? 's' : ''} ago`;
  return 'just now';
}

/**
 * Hook to load and parse checkpoints from flow state
 *
 * @param flow - Flow entity (or null)
 * @returns Object with checkpoints array, loading status, and checkpoint operations
 */
export function useProcessCheckpoints(flow: Flow | null | undefined): {
  checkpoints: CheckpointInfo[];
  loading: boolean;
  getCurrentCheckpoint: () => Promise<string | null>;
  restoreCheckpoint: (checkpointHash: string) => Promise<void>;
} {
  const flowTypeId = useMemo(() => (flow ? new TypeId(Flow.type, flow.id) : null), [flow]);
  const { state: checkpointItems }: { state: FlowCheckpointItem[] | null } = useProcessStateField(
    flowTypeId,
    FlowStateProperty.CHECKPOINT_ITEMS,
  );

  const checkpoints = useMemo(() => {
    if (!checkpointItems) return [];

    const parsed: CheckpointInfo[] = [];

    checkpointItems.forEach((item: FlowCheckpointItem, index: number) => {
      const checkpointHash = parseCheckpointHash(item.message);
      if (checkpointHash) {
        const timestamp = new Date(item.timestamp);
        parsed.push({
          checkpointHash,
          timestamp,
          index: index + 1,
          timeAgo: formatTimeAgo(timestamp),
        });
      }
    });

    return parsed;
  }, [checkpointItems]);

  /**
   * Get the current checkpoint hash (git HEAD) for the flow
   * @returns Promise with the current checkpoint hash
   */
  const getCurrentCheckpoint = useCallback(async (): Promise<string | null> => {
    if (!flow?.id) {
      throw new Error('Cannot get current checkpoint: Flow has no ID');
    }

    const action = new ActionInfo('current-checkpoint', Flow.type, flow.id, 'GET');
    try {
      const response = await dataManager.callAction<undefined, { checkpoint_hash: string }>(action);
      return response.checkpoint_hash;
    } catch (error) {
      const checkpointError = error instanceof Error ? error : new Error(String(error));
      throw new Error(`Failed to get current checkpoint: ${checkpointError.message}`);
    }
  }, [flow?.id]);

  /**
   * Restore a checkpoint using git reset --hard
   * @param checkpointHash - The git commit hash to restore to
   * @returns Promise with success/error status
   */
  const restoreCheckpoint = useCallback(
    async (checkpointHash: string): Promise<void> => {
      if (!flow?.id) {
        throw new Error('Cannot restore checkpoint: Flow has no ID');
      }

      if (!checkpointHash) {
        throw new Error('Cannot restore checkpoint: checkpoint_hash is required');
      }

      const action = new ActionInfo('restore-checkpoint', Flow.type, flow.id, 'POST');
      action.bodyParameters = { checkpoint_hash: checkpointHash };

      try {
        await dataManager.callAction<{ checkpoint_hash: string }, undefined>(action);
      } catch (error) {
        const restoreError = error instanceof Error ? error : new Error(String(error));
        throw new Error(`Failed to restore checkpoint: ${restoreError.message}`);
      }
    },
    [flow?.id],
  );

  return {
    checkpoints,
    loading: !checkpointItems,
    getCurrentCheckpoint,
    restoreCheckpoint,
  };
}
