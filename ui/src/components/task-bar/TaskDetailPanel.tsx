/**
 * TaskDetailPanel - Sliding detail panel showing task fields and related entities.
 * Read-only display; editing happens in the full dock view.
 */

import { ArrowLeft, ExternalLink, FileText } from 'lucide-react';
import type { Task } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { getPriorityColor, PRIORITY_CONFIG } from './constants';
import { getAnalysisPath, getTaskTypeLabel, openAnalysisReport } from './task-utils';

interface TaskDetailPanelProps {
  task: Task;
  onClose: () => void;
}

export function TaskDetailPanel({ task, onClose }: TaskDetailPanelProps) {
  const { navigation } = useDockNavigation();

  const handleOpenFullView = () => {
    navigation.openDock(DockPointer.forTasks(task.typeId?.toString()));
  };

  const analysisPath = getAnalysisPath(task);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border p-3">
        <button
          onClick={onClose}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{task.title || 'Untitled'}</span>
      </div>

      {/* Fields */}
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {/* Type Label */}
        {getTaskTypeLabel(task) && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Type</span>
            <div className="mt-0.5">
              <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                {getTaskTypeLabel(task)}
              </span>
            </div>
          </div>
        )}

        {/* Status */}
        <div>
          <span className="text-xs font-medium text-muted-foreground">Status</span>
          <div className="mt-0.5 text-sm capitalize">{task.status || 'open'}</div>
        </div>

        {/* Priority */}
        {task.priority && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Priority</span>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${getPriorityColor(task.priority)}`} />
              <span className="text-sm">{PRIORITY_CONFIG[task.priority]?.label || task.priority}</span>
            </div>
          </div>
        )}

        {/* Due date */}
        {task.due_at && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Due date</span>
            <div className="mt-0.5 text-sm">
              {new Date(task.due_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
            </div>
          </div>
        )}

        {/* Start date */}
        {task.start_date && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Start date</span>
            <div className="mt-0.5 text-sm">
              {new Date(task.start_date).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </div>
          </div>
        )}

        {/* Description */}
        {task.descriptionPlainText && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Description</span>
            <div className="mt-0.5 text-sm text-foreground/80">{task.descriptionPlainText}</div>
          </div>
        )}

        {/* Related entity */}
        {task.target_entity && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Related entity</span>
            <div className="mt-0.5 font-mono text-sm text-primary">{task.target_entity}</div>
          </div>
        )}

        {/* Analysis report link */}
        {analysisPath && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Analysis Report</span>
            <button
              onClick={() => openAnalysisReport(analysisPath, navigation)}
              className="mt-0.5 flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              <FileText className="h-3.5 w-3.5" />
              Open analysis.md
            </button>
          </div>
        )}
      </div>

      {/* Open full view link */}
      <div className="border-t border-border p-3">
        <button onClick={handleOpenFullView} className="flex items-center gap-1.5 text-xs text-primary hover:underline">
          <ExternalLink className="h-3 w-3" />
          Open full view
        </button>
      </div>
    </div>
  );
}
