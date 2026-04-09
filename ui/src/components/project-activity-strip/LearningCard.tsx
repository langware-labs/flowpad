import { useAnalysisTaskProgress } from '@src/hooks/use-analysis-task-progress';
import {
  getArtifactPaths,
  openArtifact,
  TaskStatus,
} from '@src/components/task-bar/task-utils';
import type { SnifferEvent } from '@src/hooks/use-hooks-sniffer';
import { getEventIcon, getEventColor, getOneLiner } from '@src/components/hooks/event-utils';
import type { Task } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Archive, Bug, Check, Loader2, Maximize2, Sparkles, X } from 'lucide-react';

interface LearningCardProps {
  task: Task;
  onArchive?: (task: Task) => void;
  sessionEventCounts?: Map<string, number>;
  sessionLatestEvent?: Map<string, SnifferEvent>;
  onOpenEventDialog?: (sessionId: string, name: string) => void;
}

export function LearningCard({
  task,
  onArchive,
  sessionEventCounts,
  sessionLatestEvent,
  onOpenEventDialog,
}: LearningCardProps) {
  const { navigation } = useDockNavigation();
  const { isRunning, isComplete, isError, statusMessage, activityLabel, elapsedTime } =
    useAnalysisTaskProgress(task);
  const artifacts = getArtifactPaths(task);

  const workerSessionId =
    (task.metadata?.workerSessionId as string | undefined) ??
    (task.metadata?.session_id as string | undefined) ??
    null;
  const isErrorTask = task.tags?.includes('error') || !!task.metadata?.errorFingerprint;
  const isInProgress = isRunning || (!isComplete && !isError && task.status === TaskStatus.IN_PROGRESS);
  const latestEvent = workerSessionId ? sessionLatestEvent?.get(workerSessionId) ?? null : null;
  const eventCount = workerSessionId ? sessionEventCounts?.get(workerSessionId) ?? 0 : 0;

  const handleCardClick = () => {
    navigation.openDock(DockPointer.forTasks(task.typeId?.toString()));
  };

  return (
    <div className="learning-card cursor-pointer" onClick={handleCardClick}>
      <div className="learning-card-header">
        {isRunning && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-500" />}
        {isComplete && <Check className="h-4 w-4 shrink-0 text-green-500" />}
        {isError && <X className="h-4 w-4 shrink-0 text-red-500" />}
        {!isRunning && !isComplete && !isError && task.status === TaskStatus.IN_PROGRESS && (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-500" />
        )}
        {!isRunning && !isComplete && !isError && task.status !== TaskStatus.IN_PROGRESS && isErrorTask && (
          <Bug className="h-4 w-4 shrink-0 text-red-500" />
        )}
        {!isRunning && !isComplete && !isError && task.status !== TaskStatus.IN_PROGRESS && !isErrorTask && (
          <Sparkles className="h-4 w-4 shrink-0 text-purple-500" />
        )}
        <span className="learning-card-title">{task.title || 'Untitled'}</span>
        {onArchive && (
          <button
            type="button"
            className="learning-card-archive"
            title="Archive"
            onClick={(e) => {
              e.stopPropagation();
              onArchive(task);
            }}
          >
            <Archive className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Live progress */}
      {isRunning && (
        <div className="learning-card-status">
          {activityLabel && <span className="learning-card-label">{activityLabel}</span>}
          {statusMessage && <span className="learning-card-message">{statusMessage}</span>}
          {!activityLabel && !statusMessage && <span className="learning-card-message">In progress...</span>}
          {elapsedTime && <span className="learning-card-elapsed">({elapsedTime})</span>}
        </div>
      )}

      {/* Fallback for in-progress tasks without a process */}
      {!isRunning && !isComplete && !isError && task.status === TaskStatus.IN_PROGRESS && (
        <div className="learning-card-status">
          <span className="learning-card-message">Creating skill...</span>
        </div>
      )}

      {/* Event indicator for in-progress tasks with a worker session */}
      {isInProgress && workerSessionId && (latestEvent || eventCount > 0) && (() => {
        const EvtIcon = latestEvent ? getEventIcon(latestEvent.event_type, latestEvent) : null;
        const evtColor = latestEvent ? getEventColor(latestEvent) : '';
        const oneLiner = latestEvent ? getOneLiner(latestEvent.hook_data) : '';
        return (
          <button
            type="button"
            className="activity-event-indicator"
            style={{ marginLeft: '1.5rem' }}
            onClick={(e) => {
              e.stopPropagation();
              onOpenEventDialog?.(workerSessionId, task.title || 'Task');
            }}
          >
            {eventCount > 0 && (
              <span className="activity-event-badge">{eventCount}</span>
            )}
            <Maximize2 className="h-3 w-3 shrink-0 text-muted-foreground" />
            {EvtIcon && <EvtIcon className={`h-3 w-3 shrink-0 ${evtColor}`} />}
            {latestEvent && (
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                {latestEvent.event_type}{oneLiner ? ` · ${oneLiner}` : ''}
              </span>
            )}
          </button>
        );
      })()}

      {/* Complete: show artifact links */}
      {isComplete && artifacts.length > 0 && (
        <div className="learning-card-artifacts">
          {artifacts.map((artifact, idx) => (
            <button
              key={idx}
              type="button"
              className="learning-card-artifact-link"
              onClick={(e) => {
                e.stopPropagation();
                if (artifact.skillDockPath) {
                  navigation.openDock(DockPointer.forSkills(artifact.skillDockPath));
                } else {
                  openArtifact(artifact.path, navigation);
                }
              }}
              title={artifact.skillDockPath ? 'Open in Skills tab' : artifact.path}
            >
              {artifact.label}
            </button>
          ))}
        </div>
      )}

      {/* Done tasks that useAnalysisTaskProgress doesn't detect as complete (no processId) */}
      {!isRunning && !isComplete && !isError && task.status === TaskStatus.DONE && artifacts.length > 0 && (
        <div className="learning-card-artifacts">
          {artifacts.map((artifact, idx) => (
            <button
              key={idx}
              type="button"
              className="learning-card-artifact-link"
              onClick={(e) => {
                e.stopPropagation();
                if (artifact.skillDockPath) {
                  navigation.openDock(DockPointer.forSkills(artifact.skillDockPath));
                } else {
                  openArtifact(artifact.path, navigation);
                }
              }}
              title={artifact.skillDockPath ? 'Open in Skills tab' : artifact.path}
            >
              {artifact.label}
            </button>
          ))}
        </div>
      )}

      {/* Error state */}
      {isError && <div className="learning-card-status"><span className="learning-card-error">Failed</span></div>}
    </div>
  );
}
