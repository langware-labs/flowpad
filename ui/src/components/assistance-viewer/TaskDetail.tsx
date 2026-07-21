import { getStatusBadgeClass } from '@src/components/task-bar/task-utils';
import { TaskComments } from '@src/components/assets/editor/task/TaskComments';
import { Task } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@src/components/ui/card';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { ArrowLeft } from 'lucide-react';
import { Trans } from '@lingui/react/macro';

interface TaskDetailProps {
  task: Task;
  onBack: () => void;
}

export function TaskDetail({ task, onBack }: TaskDetailProps) {
  const formatDate = (date: Date | undefined) => {
    if (!date) return '';
    return new Date(date).toLocaleString();
  };

  return (
    <div className="flex h-full flex-1 flex-col bg-background">
      {/* Header */}
      <div className="flex h-[52px] items-center border-b bg-muted/50 px-3">
        <Button variant="ghost" size="icon" onClick={onBack} className="mr-2 h-8 w-8">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h3 className="text-sm font-medium">{task.displayName}</h3>
          {task.status && (
            <p className="text-xs text-muted-foreground">
              <Trans>Status:</Trans>{' '}
              <span className={`inline-block rounded-full px-2 py-0.5 ${getStatusBadgeClass(task.status)}`}>
                {task.status}
              </span>
            </p>
          )}
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="space-y-4 p-4">
          {/* Task Description */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                <Trans>Description</Trans>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {task.description || <Trans>No description provided.</Trans>}
              </p>
              {task.created_date && (
                <p className="mt-2 text-xs text-muted-foreground">
                  <Trans>Created: {formatDate(task.created_date)}</Trans>
                </p>
              )}
            </CardContent>
          </Card>

          {/* Comments Section */}
          <Card>
            <CardContent className="pt-6">
              <TaskComments task={task} />
            </CardContent>
          </Card>
        </div>
      </ScrollArea>
    </div>
  );
}
