import { useTaskComments } from '@src/hooks/use-task-comments';
import { getStatusBadgeClass } from '@src/components/task-bar/task-utils';
import { Comment, Task } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@src/components/ui/card';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { Separator } from '@src/components/ui/separator';
import { Textarea } from '@src/components/ui/textarea';
import { ArrowLeft, MessageSquare, Send, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';

interface TaskDetailProps {
  task: Task;
  onBack: () => void;
}

export function TaskDetail({ task, onBack }: TaskDetailProps) {
  const [commentText, setCommentText] = useState<string>('');

  // Fetch comments for this task using the custom hook
  const { data: comments, isLoading: isLoadingComments } = useTaskComments(task);

  // Add a comment - create Comment entity with task as scope
  const handleAddComment = useCallback(async () => {
    if (!commentText.trim()) return;
    const comment = new Comment({
      raw_content: commentText,
    });
    await comment.save(task.typeId);
    setCommentText('');
  }, [commentText, task.typeId]);

  // Delete a comment directly
  const handleDeleteComment = useCallback(async (comment: Comment) => {
    await comment.delete();
  }, []);

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
              Status:{' '}
              <span
                className={`inline-block rounded-full px-2 py-0.5 ${getStatusBadgeClass(task.status)}`}
              >
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
              <CardTitle className="text-base">Description</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {task.description || 'No description provided.'}
              </p>
              {task.created_date && (
                <p className="mt-2 text-xs text-muted-foreground">Created: {formatDate(task.created_date)}</p>
              )}
            </CardContent>
          </Card>

          {/* Comments Section */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <MessageSquare className="h-4 w-4" />
                Comments ({comments?.length || 0})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {isLoadingComments ? (
                <p className="text-sm text-muted-foreground">Loading comments...</p>
              ) : comments && comments.length > 0 ? (
                <div className="space-y-3">
                  {comments.map((comment) => (
                    <Card key={comment.id} className="bg-muted/30">
                      <CardContent className="p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1">
                            <p className="whitespace-pre-wrap text-sm">{comment.raw_content}</p>
                            <p className="mt-1 text-xs text-muted-foreground">{formatDate(comment.created_date)}</p>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-destructive hover:text-destructive"
                            onClick={() => {
                              void handleDeleteComment(comment);
                            }}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No comments yet.</p>
              )}

              <Separator className="my-3" />

              {/* Add Comment Input */}
              <div className="space-y-2">
                <Textarea
                  placeholder="Add a comment..."
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  className="min-h-[80px] resize-none text-sm"
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={() => {
                      void handleAddComment();
                    }}
                    disabled={!commentText.trim()}
                  >
                    <Send className="mr-2 h-3 w-3" />
                    Send
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </ScrollArea>
    </div>
  );
}
