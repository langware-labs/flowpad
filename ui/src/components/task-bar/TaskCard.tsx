/**
 * TaskCard - Single task row with title, due date, priority dot,
 * hover action bar, and click-to-expand.
 *
 * For analysis tasks, shows a collapsible progress sub-row.
 * Supports bulk selection mode with checkbox replacing the priority dot.
 */

import { Archive, Check, CheckCircle, ChevronRight, FileText, Loader2, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { Task } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useAnalysisTaskProgress } from '@src/hooks/use-analysis-task-progress';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { formatDueDate, getPriorityColor } from './constants';
import {
  getAnalysisJsonPath,
  getAnalysisPath,
  getArtifactPaths,
  getTaskTypeLabel,
  openArtifact,
  TaskStatus,
  TaskType,
} from './task-utils';
import { ReminderButton } from './ReminderButton';

interface TaskCardProps {
  task: Task;
  onExpand: (task: Task) => void;
  onRemove: (task: Task) => void;
  onSetReminder: (task: Task, date: Date) => void;
  bulkMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (taskId: string) => void;
}

function AnalysisProgressRow({ task }: { task: Task }) {
  const { navigation } = useDockNavigation();
  const { isRunning, isComplete, isError, statusMessage, activityLabel, elapsedTime } = useAnalysisTaskProgress(task);
  const analysisPath = getAnalysisPath(task);
  const analysisJsonPath = getAnalysisJsonPath(task);

  const isActive = isRunning;

  if (!isActive && !isComplete && !isError) return null;

  return (
    <div className="flex items-center gap-2 border-t border-border/60 bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground">
      {isActive && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-amber-500" />}
      {isComplete && <Check className="h-3 w-3 shrink-0 text-green-500" />}
      {isError && <X className="h-3 w-3 shrink-0 text-red-500" />}

      <div className="min-w-0 flex-1">
        {isActive && (
          <div className="flex items-center gap-1.5">
            {activityLabel && <span className="text-[9px] font-medium">{activityLabel}</span>}
            {statusMessage && <span className="truncate">{statusMessage}</span>}
            {!activityLabel && !statusMessage && <span>Analysis in progress...</span>}
            {elapsedTime && (
              <span className="ml-auto shrink-0 text-[9px] text-muted-foreground/70">({elapsedTime})</span>
            )}
          </div>
        )}
        {isComplete && (
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-medium text-green-600 dark:text-green-400">Analysis complete</span>
            {analysisPath && (
              <button
                type="button"
                className="text-[9px] text-primary underline hover:text-primary/80"
                onClick={(e) => {
                  e.stopPropagation();
                  openArtifact(analysisPath, navigation);
                }}
              >
                Open report
              </button>
            )}
            {analysisJsonPath && (
              <button
                type="button"
                className="text-[9px] text-primary underline hover:text-primary/80"
                onClick={(e) => {
                  e.stopPropagation();
                  openArtifact(analysisJsonPath, navigation);
                }}
              >
                Open JSON
              </button>
            )}
          </div>
        )}
        {isError && <span className="text-[9px] font-medium text-red-500">Analysis failed</span>}
      </div>
    </div>
  );
}

/**
 * Generic artifacts row for tasks with completed artifacts.
 * Shows links to skill files, reports, or any other task artifacts.
 */
function ArtifactsRow({ task }: { task: Task }) {
  const { navigation } = useDockNavigation();
  const artifacts = getArtifactPaths(task);

  // Only show if task is done/completed and has artifacts
  const isDone = task.status === TaskStatus.DONE;
  if (!isDone || artifacts.length === 0) return null;

  return (
    <div className="flex items-center gap-2 border-t border-border/60 bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground">
      <FileText className="h-3 w-3 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[9px] font-medium">Artifacts:</span>
          {artifacts.map((artifact, index) => (
            <button
              key={index}
              type="button"
              className="text-[9px] text-primary underline hover:text-primary/80"
              onClick={(e) => {
                e.stopPropagation();
                if (artifact.skillDockPath) {
                  navigation.openDock(DockPointer.forSkills(artifact.skillDockPath));
                } else {
                  openArtifact(artifact.path, navigation);
                }
              }}
              title={artifact.skillDockPath ? `Open in Skills tab` : artifact.path}
            >
              {artifact.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function TaskCard({
  task,
  onExpand,
  onRemove,
  onSetReminder,
  bulkMode,
  isSelected,
  onToggleSelect,
}: TaskCardProps) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const isAlreadyArchived = task.status === 'archived' || !!task.archived_at;
  const actionLabel = isAlreadyArchived ? 'Delete' : 'Archive';
  const ActionIcon = isAlreadyArchived ? Trash2 : Archive;
  const dueDateLabel = formatDueDate(task.due_at);
  const isAnalysisTask = task.task_type === TaskType.ANALYSIS;

  const handleClick = () => {
    if (bulkMode && task.id && onToggleSelect) {
      onToggleSelect(task.id);
    } else {
      onExpand(task);
    }
  };

  return (
    <div className="task-card-wrapper group relative">
      <button className="task-card" onClick={handleClick}>
        {/* Status / Priority indicator OR Bulk checkbox */}
        {bulkMode ? (
          <span className={`task-card-checkbox ${isSelected ? 'checked' : ''}`}>
            {isSelected && <Check className="h-2.5 w-2.5 text-white" />}
          </span>
        ) : task.status === TaskStatus.DONE ? (
          <CheckCircle className="h-4 w-4 shrink-0 text-green-500" />
        ) : task.status === TaskStatus.IN_PROGRESS ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-500" />
        ) : (
          <span className={`h-2 w-2 shrink-0 rounded-full ${getPriorityColor(task.priority)}`} />
        )}

        <div className="ml-1 min-w-0 flex-1">
          <div className="flex flex-col gap-0.5">
            {getTaskTypeLabel(task) && (
              <div className="flex items-center gap-2">
                <span className="inline-flex shrink-0 items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                  {getTaskTypeLabel(task)}
                </span>
              </div>
            )}
            <div className="min-w-0 truncate pl-2 text-sm font-medium" title={task.title || 'Untitled'}>
              {task.title || 'Untitled'}
            </div>
          </div>
          {dueDateLabel && <div className="truncate text-xs text-muted-foreground">{dueDateLabel}</div>}
        </div>

        {!bulkMode && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      </button>

      {/* Analysis progress sub-row */}
      {isAnalysisTask && <AnalysisProgressRow task={task} />}

      {/* Generic artifacts row for non-analysis tasks */}
      {!isAnalysisTask && <ArtifactsRow task={task} />}

      {/* Horizontal action bar - visible on hover, hidden in bulk mode */}
      {!bulkMode && (
        <div className="task-card-actions">
          <button
            className="task-card-action task-card-action-archive"
            title={actionLabel}
            onClick={(e) => {
              e.stopPropagation();
              setConfirmRemove(true);
            }}
          >
            <ActionIcon className="h-3.5 w-3.5" />
          </button>
          <ReminderButton task={task} onSetReminder={onSetReminder} />
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`${actionLabel} task`}
        description={`Are you sure you want to ${actionLabel.toLowerCase()} "${task.title || 'Untitled'}"?`}
        confirmLabel={actionLabel}
        variant="destructive"
        onConfirm={() => onRemove(task)}
      />
    </div>
  );
}
