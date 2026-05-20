import { useState } from 'react';
import { Share2 } from 'lucide-react';
import { TypeId } from '@sdk';
import { FavoriteStar } from '@src/components/favorites/FavoriteStar';
import { EntityShareDialog } from '@src/components/terminal/interactive-terminal/EntityShareDialog';
import { useEntityShare } from '@src/hooks/use-entity-share';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';

type Variant = 'prominent' | 'compact';

export interface EntityActionsToolbarProps {
  typeId: TypeId;
  /** Display label for the favorite tile when the user toggles it on. */
  favoriteTitle: string;
  /** Optional icon key persisted on the bookmark.data; FavoriteTile uses it on home. */
  favoriteIcon?: string;
  /**
   * 'prominent' (default for header surfaces) renders Share as a labeled pill.
   * 'compact' renders Share as an icon-only button.
   */
  variant?: Variant;
  /** Slot for caller-supplied extra trailing actions. */
  trailing?: React.ReactNode;
  /** Surface-level opt-in for the "Copy link" share mode. Defaults to false. */
  allowCopyLink?: boolean;
  onShared?: () => void;
  className?: string;
}

/**
 * Generic Share + Favorite toolbar — drop into any entity surface.
 *
 *   <EntityActionsToolbar typeId={process.typeId} favoriteTitle="My session" variant="prominent" />
 *
 * Share opens the EntityShareDialog (send / copy link / download bundle).
 * Favorite is the existing FavoriteStar — persists a Bookmark(bookmark_type=favorite)
 * that the homepage MiniDesktop renders.
 */
export function EntityActionsToolbar({
  typeId,
  favoriteTitle,
  favoriteIcon,
  variant = 'compact',
  trailing,
  allowCopyLink = false,
  onShared,
  className,
}: EntityActionsToolbarProps) {
  const [shareOpen, setShareOpen] = useState(false);
  const { canShare } = useEntityShare(typeId);

  const handleClose = () => {
    setShareOpen(false);
    onShared?.();
  };

  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      {variant === 'prominent' ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              disabled={!canShare}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
                'bg-primary/10 text-primary hover:bg-primary/15',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
              data-testid="entity-actions-share"
              aria-label="Share"
            >
              <Share2 className="h-3.5 w-3.5" />
              Share
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {canShare ? 'Share, copy link, or download as bundle' : 'Loading…'}
          </TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              disabled={!canShare}
              className={cn(
                'inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
              data-testid="entity-actions-share"
              aria-label="Share"
            >
              <Share2 className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {canShare ? 'Share' : 'Loading…'}
          </TooltipContent>
        </Tooltip>
      )}

      <FavoriteStar
        entityType={typeId.type}
        entityId={typeId.id}
        title={favoriteTitle}
        icon={favoriteIcon}
        size={variant === 'prominent' ? 16 : 14}
      />

      {trailing}

      {shareOpen && (
        <EntityShareDialog
          open={shareOpen}
          onClose={handleClose}
          typeId={typeId}
          defaultTitle={favoriteTitle}
          allowCopyLink={allowCopyLink}
        />
      )}
    </div>
  );
}
