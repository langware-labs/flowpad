import { useMemo, useState } from 'react';
import { Download, Link2 } from 'lucide-react';
import { TypeId } from '@sdk';
import { FavoriteStar } from '@src/components/favorites/FavoriteStar';
import { ShareButton } from '@src/components/entity-actions/ShareButton';
import { EntityShareDialog } from '@src/components/terminal/interactive-terminal/EntityShareDialog';
import { ShareToConversationDialog } from '@src/components/share-to-conversation/ShareToConversationDialog';
import {
  agenticProcessShareSource,
  genericEntityShareSource,
} from '@src/hooks/share-sources';
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
  const [exportOpen, setExportOpen] = useState(false);
  const { canShare, isAgenticProcess } = useEntityShare(typeId);

  // The conversation share's prep: AgenticProcess shares its ClaudeTranscript
  // (claude_session) entity; any other entity rides as a TYPE_ID attachment.
  // Keyed on ``shareOpen`` so each open gets a fresh source (its resolve-once
  // cache resets).
  const shareSource = useMemo(
    () =>
      isAgenticProcess
        ? agenticProcessShareSource(typeId, { label: favoriteTitle, defaultTitle: favoriteTitle })
        : genericEntityShareSource(typeId, { label: favoriteTitle }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [typeId, isAgenticProcess, favoriteTitle, shareOpen],
  );

  const handleClose = () => {
    setShareOpen(false);
    onShared?.();
  };

  const exportLabel = allowCopyLink ? 'Copy link or download bundle' : 'Download bundle';

  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      <ShareButton
        variant={variant}
        onClick={() => setShareOpen(true)}
        disabled={!canShare}
        tooltip={canShare ? (variant === 'prominent' ? 'Share to a conversation' : 'Share') : 'Loading…'}
        testId="entity-actions-share"
      />

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setExportOpen(true)}
            disabled={!canShare}
            className={cn(
              'inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
            data-testid="entity-actions-export"
            aria-label={exportLabel}
          >
            {allowCopyLink ? (
              <Link2 className="h-3.5 w-3.5" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {exportLabel}
        </TooltipContent>
      </Tooltip>

      <FavoriteStar
        entityType={typeId.type}
        entityId={typeId.id}
        title={favoriteTitle}
        icon={favoriteIcon}
        size={variant === 'prominent' ? 16 : 14}
      />

      {trailing}

      {shareOpen && (
        <ShareToConversationDialog
          open={shareOpen}
          onClose={handleClose}
          source={shareSource}
        />
      )}

      {exportOpen && (
        <EntityShareDialog
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          typeId={typeId}
          defaultTitle={favoriteTitle}
          allowCopyLink={allowCopyLink}
        />
      )}
    </div>
  );
}
