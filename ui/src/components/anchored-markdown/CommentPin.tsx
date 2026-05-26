import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { cn } from '@src/lib/utils';
import { MessageCircle, Trash2 } from 'lucide-react';
import { useState } from 'react';

export interface CommentMark {
  /** TypeId of the Comment entity (used for delete). */
  commentId: string;
  /** Comment body — shown in the popover. */
  text: string;
  /** ISO timestamp shown in the popover footer. Optional. */
  createdAt?: string;
  /** When provided, the popover renders a delete button that calls this. */
  onDelete?: () => Promise<void> | void;
}

export function CommentPin({ mark }: { mark: CommentMark }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleDelete = async () => {
    if (!mark.onDelete || busy) return;
    setBusy(true);
    try {
      await mark.onDelete();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={`comment-pin-${mark.commentId}`}
          data-comment-id={mark.commentId}
          aria-label="Open comment"
          className={cn(
            'flex h-4 w-4 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-600 transition-colors',
            'hover:bg-amber-500/20 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300',
          )}
        >
          <MessageCircle className="h-2.5 w-2.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="left"
        align="start"
        sideOffset={6}
        className="w-72 p-3"
        data-testid={`comment-popover-${mark.commentId}`}
      >
        <div className="space-y-2">
          <p
            className="whitespace-pre-wrap break-words text-sm leading-relaxed"
            data-testid="comment-popover-text"
          >
            {mark.text || <span className="italic text-muted-foreground">(empty)</span>}
          </p>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">
              {mark.createdAt ? new Date(mark.createdAt).toLocaleString() : ''}
            </span>
            {mark.onDelete && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={busy}
                data-testid={`comment-delete-${mark.commentId}`}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
              >
                <Trash2 className="h-2.5 w-2.5" />
                Delete
              </button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
