import { Comment, Task } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Textarea } from '@src/components/ui/textarea';
import { useTaskComments } from '@src/hooks/use-task-comments';
import { MessageSquare, Send, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

interface TaskCommentsProps {
  task: Task;
}

const formatDate = (date: Date | string | undefined) => {
  if (!date) return '';
  return new Date(date).toLocaleString();
};

/**
 * Comments thread for a task — lists existing comments oldest-first and offers
 * an add box. Backed by `useTaskComments`, which scopes comments to this task
 * via `parent_type_id`. Shared by the primary task surface (`TaskAssetEditor`)
 * and the assistance-viewer `TaskDetail`.
 */
export function TaskComments({ task }: TaskCommentsProps) {
  const { t } = useLingui();
  const [commentText, setCommentText] = useState('');
  const { data: comments, isLoading, addComment, deleteComment } = useTaskComments(task);

  const handleAdd = useCallback(async () => {
    const text = commentText.trim();
    if (!text) return;
    setCommentText('');
    await addComment(text);
  }, [commentText, addComment]);

  const handleDelete = useCallback(
    (comment: Comment) => {
      void deleteComment(comment);
    },
    [deleteComment],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <MessageSquare className="h-3.5 w-3.5" />
        <Trans>Comments ({comments?.length || 0})</Trans>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Loading comments…</Trans>
        </p>
      ) : comments && comments.length > 0 ? (
        <div className="flex flex-col gap-2">
          {comments.map((comment) => (
            <div key={comment.id} className="flex items-start justify-between gap-2 rounded-md border bg-muted/30 p-3">
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap break-words text-sm">{comment.raw_content}</p>
                <p className="mt-1 text-xs text-muted-foreground">{formatDate(comment.created_date)}</p>
              </div>
              <button
                onClick={() => handleDelete(comment)}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                title={t`Delete comment`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          <Trans>No comments yet.</Trans>
        </p>
      )}

      <div className="flex flex-col gap-2">
        <Textarea
          placeholder={t`Add a comment…`}
          value={commentText}
          onChange={(e) => setCommentText(e.target.value)}
          className="min-h-[72px] resize-none text-sm"
        />
        <div className="flex justify-end">
          <Button size="sm" onClick={() => void handleAdd()} disabled={!commentText.trim()}>
            <Send className="mr-2 h-3 w-3" />
            <Trans>Send</Trans>
          </Button>
        </div>
      </div>
    </div>
  );
}
