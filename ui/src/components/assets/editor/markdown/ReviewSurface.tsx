import {
  AnchoredSurface,
  buildMarkerTrack,
  useAnchorVersion,
  useReactMarkdownAnchor,
  type LineAnchorProvider,
} from '@src/components/anchored-markdown';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Textarea } from '@src/components/ui/textarea';
import { useDocComments } from '@src/hooks/use-doc-comments';
import { Plus } from 'lucide-react';
import { useCallback, useMemo, useState, type MouseEvent } from 'react';
import { useLingui, Trans } from '@lingui/react/macro';

interface ReviewSurfaceProps {
  body: string;
  /** Serialized parent TypeId (e.g. `"plan-<uuid>"`). Null = no add/delete affordances. */
  docTypeId: string | null;
}

export function ReviewSurface({ body, docTypeId }: ReviewSurfaceProps) {
  const { body: renderedBody, provider } = useReactMarkdownAnchor(body);
  const { comments, addComment, deleteComment } = useDocComments(docTypeId);

  const track = useMemo(
    () =>
      buildMarkerTrack(
        comments.map((c) => ({
          id: c.id,
          anchor: { line: c.line },
          data: {
            kind: 'comment',
            mark: {
              commentId: c.id,
              text: c.text,
              createdAt: c.createdAt,
              onDelete: () => deleteComment(c.entity),
            },
          },
        })),
      ),
    [comments, deleteComment],
  );

  return (
    <div className="h-full overflow-auto" data-testid="review-surface">
      <AnchoredSurface provider={provider} rightTracks={[track]}>
        <AddCommentOverlay
          provider={provider}
          enabled={docTypeId != null}
          onSubmit={addComment}
        >
          {renderedBody}
        </AddCommentOverlay>
      </AnchoredSurface>
    </div>
  );
}

interface AddCommentOverlayProps {
  provider: LineAnchorProvider;
  enabled: boolean;
  onSubmit: (line: number, text: string) => Promise<void>;
  children: React.ReactNode;
}

function AddCommentOverlay({ provider, enabled, onSubmit, children }: AddCommentOverlayProps) {
  // Repositions the "+" when font-load / resize bumps the provider's rects.
  useAnchorVersion(provider);

  const { t } = useLingui();

  const [hoveredLine, setHoveredLine] = useState<number | null>(null);
  const [composer, setComposer] = useState<{ line: number } | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const handleMouseMove = useCallback((e: MouseEvent<HTMLDivElement>) => {
    if (composer) return;
    const block = (e.target as Element | null)?.closest?.('[data-line]') as HTMLElement | null;
    const raw = block ? Number(block.dataset.line) : NaN;
    const next = Number.isFinite(raw) && raw > 0 ? raw : null;
    setHoveredLine((prev) => (prev === next ? prev : next));
  }, [composer]);

  const handleMouseLeave = useCallback(() => {
    if (composer) return;
    setHoveredLine((prev) => (prev === null ? prev : null));
  }, [composer]);

  const openComposer = useCallback(() => {
    if (hoveredLine == null) return;
    setText('');
    setComposer({ line: hoveredLine });
  }, [hoveredLine]);

  const closeComposer = useCallback(() => {
    setComposer(null);
    setText('');
    setBusy(false);
  }, []);

  const submit = useCallback(async () => {
    if (!composer || !text.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(composer.line, text);
      closeComposer();
    } catch {
      setBusy(false);
    }
  }, [composer, text, busy, onSubmit, closeComposer]);

  const activeLine = composer?.line ?? hoveredLine;
  const activeRect = activeLine != null ? provider.getRect(activeLine) : null;

  return (
    <div
      className="relative"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {enabled && activeRect && activeLine != null && (
        <Popover
          open={composer != null}
          onOpenChange={(open) => { if (!open) closeComposer(); }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid={`comment-add-line-${activeLine}`}
              aria-label={t`Add comment at line ${activeLine}`}
              className="absolute right-1 z-10 flex h-4 w-4 items-center justify-center rounded-full border border-amber-500/30 bg-background/85 text-amber-600 opacity-70 transition-opacity hover:opacity-100 dark:text-amber-400"
              style={{ top: activeRect.top }}
              onClick={openComposer}
            >
              <Plus className="h-2.5 w-2.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="left"
            align="start"
            sideOffset={6}
            className="w-72 p-3"
            data-testid="comment-composer"
          >
            <div className="space-y-2">
              <Textarea
                autoFocus
                placeholder={t`Add a comment…`}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void submit();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    closeComposer();
                  }
                }}
                rows={3}
                className="resize-none text-sm"
                data-testid="comment-composer-textarea"
              />
              <div className="flex items-center justify-end gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={closeComposer}
                  disabled={busy}
                >
                  <Trans>Cancel</Trans>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={submit}
                  disabled={busy || !text.trim()}
                  data-testid="comment-composer-submit"
                >
                  <Trans>Comment</Trans>
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
