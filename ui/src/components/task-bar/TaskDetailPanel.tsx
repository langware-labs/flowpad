/**
 * TaskDetailPanel - Sliding detail panel showing task fields and related entities.
 * Read-only display; editing happens in the full dock view.
 */

import { ArrowLeft, ExternalLink, FileText } from 'lucide-react';
import { Spec, Task, TypeId, User } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { ExpansionRequest } from '@sdk/FlowSync/query';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { EntityActionsToolbar } from '@src/components/entity-actions/EntityActionsToolbar';
import { getPriorityColor, PRIORITY_CONFIG } from './constants';
import { getAnalysisPath, getTaskTypeLabel, openAnalysisReport } from './task-utils';
import { ConversationPanel } from '@src/components/conversation/ConversationPanel';
import { Trans, useLingui } from '@lingui/react/macro';

interface TaskDetailPanelProps {
  task: Task;
  onClose: () => void;
}

function displayName(user: User | null | undefined, fallback?: string | null): string {
  return user?.name || user?.email || fallback || 'Unknown';
}

export function TaskDetailPanel({ task, onClose }: TaskDetailPanelProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const blobExpansion = new ExpansionRequest({ expand: ['blobs'] });
  const specTypeId = task.firstContextOfType?.('spec') ?? null;
  const conversationTypeId = task.firstContextOfType?.('conversation') ?? null;
  const isSharedTask = !!specTypeId;

  const { data: sender } = useEntity<User>(
    task.shared_by_id ? new TypeId(User.type, task.shared_by_id) : null,
  );
  const { data: spec } = useEntity<Spec>(
    specTypeId,
    { query: blobExpansion },
  );
  const handleOpenFullView = () => {
    navigation.openDock(DockPointer.forTasks(task.id));
  };

  const analysisPath = getAnalysisPath(task);

  return (
    <div className="flex h-full flex-row">
      <div className="flex min-w-0 flex-1 flex-col">
      {/* Conversation host: TaskDetailPanel renders the conversation in compact
          mode; the conversation's own bottom ribbon sticks to the bottom of
          this column above the "Open full view" footer below. */}
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border p-3">
        <button
          onClick={onClose}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{task.displayName}</span>
        {task.id && (
          <EntityActionsToolbar
            typeId={new TypeId(Task.type, task.id)}
            favoriteTitle={task.displayName}
            variant="compact"
          />
        )}
      </div>

      {/* Fields */}
      <div className="flex-1 space-y-3 overflow-y-auto p-3">

        {/* From (shared task) */}
        {isSharedTask && (
          <div>
            <span className="text-xs font-medium text-muted-foreground"><Trans>From</Trans></span>
            <div className="mt-0.5 text-sm">{displayName(sender, task.shared_by_id)}</div>
          </div>
        )}

        {/* Type Label */}
        {(isSharedTask || getTaskTypeLabel(task)) && (
          <div>
            <span className="text-xs font-medium text-muted-foreground"><Trans>Type</Trans></span>
            <div className="mt-0.5">
              <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                {isSharedTask ? t`Task` : getTaskTypeLabel(task)}
              </span>
            </div>
          </div>
        )}

        {/* Status */}
        <div>
          <span className="text-xs font-medium text-muted-foreground"><Trans>Status</Trans></span>
          <div className="mt-0.5 text-sm capitalize">{task.status || t`open`}</div>
        </div>

        {/* Priority */}
        {task.priority && (
          <div>
            <span className="text-xs font-medium text-muted-foreground"><Trans>Priority</Trans></span>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${getPriorityColor(task.priority)}`} />
              <span className="text-sm">{PRIORITY_CONFIG[task.priority]?.label || task.priority}</span>
            </div>
          </div>
        )}

        {/* Due date */}
        {task.due_at && (
          <div>
            <span className="text-xs font-medium text-muted-foreground"><Trans>Due date</Trans></span>
            <div className="mt-0.5 text-sm">
              {new Date(task.due_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
            </div>
          </div>
        )}

        {/* Description */}
        {task.descriptionPlainText && (
          <div>
            <span className="text-xs font-medium text-muted-foreground"><Trans>Description</Trans></span>
            <div className="mt-0.5 text-sm text-foreground/80">{task.descriptionPlainText}</div>
          </div>
        )}

        {/* Related entity */}
        {task.target_entity && (
          <div>
            <span className="text-xs font-medium text-muted-foreground"><Trans>Related entity</Trans></span>
            <div className="mt-0.5 font-mono text-sm text-primary">{task.target_entity}</div>
          </div>
        )}

        {/* Analysis report link */}
        {analysisPath && (
          <div>
            <span className="text-xs font-medium text-muted-foreground"><Trans>Analysis Report</Trans></span>
            <button
              onClick={() => openAnalysisReport(analysisPath, navigation)}
              className="mt-0.5 flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              <FileText className="h-3.5 w-3.5" />
              <Trans>Open analysis.md</Trans>
            </button>
          </div>
        )}

        {/* ── Shared task section ─────────────────────────────── */}
        {isSharedTask && (
          <>
            {/* Spec content */}
            {spec?.content && (
              <div>
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {spec.spec_type ? t`Spec · ${spec.spec_type}` : t`Spec`}
                </span>
                <div className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded border border-border p-2 text-sm text-foreground/80">
                  {spec.content}
                </div>
              </div>
            )}

            {/* Conversation thread */}
            {conversationTypeId && (
              <ConversationPanel
                task={task}
                conversationId={conversationTypeId.id}
                variant="compact"
              />
            )}
          </>
        )}
      </div>

      {/* Footer: Open full view */}
      <div className="flex items-center border-t border-border p-3">
        <button onClick={handleOpenFullView} className="flex items-center gap-1.5 text-xs text-primary hover:underline">
          <ExternalLink className="h-3 w-3" />
          <Trans>Open full view</Trans>
        </button>
      </div>
      </div>
    </div>
  );
}
