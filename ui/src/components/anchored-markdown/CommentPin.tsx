import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Textarea } from '@src/components/ui/textarea';
import { cn } from '@src/lib/utils';
import { MessageCircle, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Trans } from '@lingui/react/macro';

export interface CommentMark {
  /** TypeId of the Comment entity (used for delete). */
  commentId: string;
  /** Comment body — shown in the popover. */
  text: string;
  /** ISO timestamp shown in the popover footer. Optional. */
  createdAt?: string;
  /** When provided, the popover renders an edit button that calls this with the new text. */
  onUpdate?: (text: string) => Promise<void> | void;
  /** When provided, the popover renders a delete button that calls this. */
  onDelete?: () => Promise<void> | void;
}

export function CommentPin({ mark }: { mark: CommentMark }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(mark.text);

  const startEdit = () => {
    setDraft(mark.text);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft(mark.text);
  };

  const handleUpdate = async () => {
    if (!mark.onUpdate || busy || !draft.trim()) return;
    setBusy(true);
    try {
      await mark.onUpdate(draft);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

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
          aria-label={t`Open comment`}
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
          {editing ? (
            <>
              <Textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void handleUpdate();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelEdit();
                  }
                }}
                rows={3}
                className="resize-none text-sm"
                data-testid="comment-edit-textarea"
              />
              <div className="flex items-center justify-end gap-1">
                <Button type="button" variant="ghost" size="sm" onClick={cancelEdit} disabled={busy}>
                  <Trans>Cancel</Trans>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleUpdate}
                  disabled={busy || !draft.trim()}
                  data-testid={`comment-edit-save-${mark.commentId}`}
                >
                  <Trans>Save</Trans>
                </Button>
              </div>
            </>
          ) : (
            <>
              <p
                className="whitespace-pre-wrap break-words text-sm leading-relaxed"
                data-testid="comment-popover-text"
              >
                {mark.text || <span className="italic text-muted-foreground"><Trans>(empty)</Trans></span>}
              </p>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">
                  {mark.createdAt ? new Date(mark.createdAt).toLocaleString() : ''}
                </span>
                <div className="flex items-center gap-1">
                  {mark.onUpdate && (
                    <button
                      type="button"
                      onClick={startEdit}
                      disabled={busy}
                      data-testid={`comment-edit-${mark.commentId}`}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-amber-500/10 hover:text-amber-600 disabled:opacity-50 dark:hover:text-amber-400"
                    >
                      <Pencil className="h-2.5 w-2.5" />
                      <Trans>Edit</Trans>
                    </button>
                  )}
                  {mark.onDelete && (
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={busy}
                      data-testid={`comment-delete-${mark.commentId}`}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                    >
                      <Trash2 className="h-2.5 w-2.5" />
                      <Trans>Delete</Trans>
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
