import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { ActionInfo, AgenticProcess } from '@sdk';
import { useDockNavigation } from '@src/navigation';
import { useAction } from '@src/hooks/use-action';
import { useProcessCheckpoints } from '@src/hooks/flow-hooks';
import { DiffContent } from './DiffContent';
import React, { useMemo } from 'react';
import { useParams } from 'react-router';

interface DiffViewerProps {
  checkpoint_hash: string;
}

const DiffViewer: React.FC<DiffViewerProps> = ({ checkpoint_hash }) => {
  const { processId } = useParams();
  const { flow } = useAgentContext();
  const { navigation } = useDockNavigation();
  const { checkpoints, loading: checkpointsLoading } = useProcessCheckpoints(flow);

  const getGitDiffActionInfo = React.useMemo(() => {
    if (!processId || !checkpoint_hash) {
      return null;
    }
    const actionInfo = new ActionInfo('checkpoint-diff', AgenticProcess.type, processId, 'GET');
    actionInfo.queryParameters = { checkpoint_hash };
    return actionInfo;
  }, [processId, checkpoint_hash]);

  const { data: gitDiff, loading: diffLoading, error: diffError } = useAction<string>(getGitDiffActionInfo);

  const handleCheckpointChange = (selectedCheckpointHash: string) => {
    if (selectedCheckpointHash && selectedCheckpointHash !== checkpoint_hash) {
      navigation.openDiff(selectedCheckpointHash);
    }
  };

  // Build selector options - always show current checkpoint, add others if available
  const selectorOptions = useMemo(() => {
    const currentCheckpointInList = checkpoints.find((cp) => cp.checkpointHash === checkpoint_hash);

    // If checkpoints loaded and current checkpoint is in the list, use the list
    if (!checkpointsLoading && currentCheckpointInList) {
      return checkpoints;
    }

    // Otherwise, create a minimal option for the current checkpoint
    if (checkpoint_hash) {
      const currentOption = {
        checkpointHash: checkpoint_hash,
        timestamp: new Date(),
        index: 1,
        timeAgo: 'current',
      };

      // If checkpoints loaded but current not in list, add it at the beginning
      if (!checkpointsLoading && checkpoints.length > 0) {
        return [currentOption, ...checkpoints];
      }

      // Otherwise just show current
      return [currentOption];
    }

    return checkpoints;
  }, [checkpoint_hash, checkpoints, checkpointsLoading]);

  return (
    <div className="flex h-full flex-col">
      {/* Header with checkpoint selector - show if we have a checkpoint */}
      {checkpoint_hash && selectorOptions.length > 0 && (
        <div className="border-b bg-background px-4 py-3">
          <div className="flex items-center gap-3">
            <label htmlFor="checkpoint-selector" className="text-sm font-medium">
              Checkpoint:
            </label>
            <select
              id="checkpoint-selector"
              value={checkpoint_hash}
              onChange={(e) => handleCheckpointChange(e.target.value)}
              className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              disabled={selectorOptions.length <= 1}
            >
              {selectorOptions.map((cp) => {
                // Format: "#1 - 2 hours ago (abc123...)"
                const shortHash = cp.checkpointHash.substring(0, 7);
                const label = `#${cp.index} - ${cp.timeAgo} (${shortHash})`;
                return (
                  <option key={cp.checkpointHash} value={cp.checkpointHash}>
                    {label}
                  </option>
                );
              })}
            </select>
          </div>
        </div>
      )}

      {/* Diff content */}
      <div key={checkpoint_hash} className="flex-1 overflow-auto pb-8">
        {diffLoading ? (
          <div className="flex h-full items-center justify-center p-4 text-muted-foreground">
            <div className="flex flex-col items-center gap-2">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted-foreground border-t-transparent"></div>
              <span>Loading checkpoint diff...</span>
            </div>
          </div>
        ) : diffError ? (
          <div className="flex h-full items-center justify-center p-4 text-destructive">
            Error loading checkpoint: {diffError.message || 'Checkpoint not found'}
          </div>
        ) : gitDiff ? (
          <DiffContent diffString={gitDiff} />
        ) : (
          <div className="flex h-full items-center justify-center p-4 text-muted-foreground">No changes to show</div>
        )}
      </div>
    </div>
  );
};

export default DiffViewer;
