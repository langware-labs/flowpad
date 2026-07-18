import { AgenticProcess } from '@sdk';
import { useCallback, useMemo } from 'react';

export interface CheckpointInfo {
  checkpointHash: string;
  timestamp: Date;
  index: number;
  timeAgo: string;
}

/**
 * RETIRED — checkpoints were a legacy conversational-Flow feature
 * (`current-checkpoint` / `restore-checkpoint` actions on the removed `flow`
 * entity, fed by its state stream). No AgenticProcess successor exists yet, so
 * this hook is an honest stub: consumers (DiffViewer, vibe-workspace) keep
 * compiling and render their empty states instead of firing dead requests.
 * Bring back per-process checkpoints on AgenticProcess before reviving this.
 */
export function useProcessCheckpoints(_process: AgenticProcess | null | undefined): {
  checkpoints: CheckpointInfo[];
  loading: boolean;
  getCurrentCheckpoint: () => Promise<string | null>;
  restoreCheckpoint: (checkpointHash: string) => Promise<void>;
} {
  const checkpoints = useMemo<CheckpointInfo[]>(() => [], []);
  const getCurrentCheckpoint = useCallback(
    (): Promise<string | null> =>
      Promise.reject(new Error('Checkpoints retired with the legacy Flow engine')),
    [],
  );
  const restoreCheckpoint = useCallback(
    (_checkpointHash: string): Promise<void> =>
      Promise.reject(new Error('Checkpoints retired with the legacy Flow engine')),
    [],
  );
  return { checkpoints, loading: false, getCurrentCheckpoint, restoreCheckpoint };
}
