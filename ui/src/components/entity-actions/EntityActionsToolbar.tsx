import { useMemo, useState } from 'react';
import { TypeId } from '@sdk';
import { compactEntityActionClassName } from '@src/components/entity-actions/action-button-styles';
import { FavoriteStar } from '@src/components/favorites/FavoriteStar';
import { ShareButton } from '@src/components/entity-actions/ShareButton';
import { ShareToConversationDialog } from '@src/components/share-to-conversation/ShareToConversationDialog';
import {
  agenticProcessShareSource,
  genericEntityShareSource,
} from '@src/hooks/share-sources';
import { useEntityShare } from '@src/hooks/use-entity-share';
import { cn } from '@src/lib/utils';

type Variant = 'prominent' | 'compact';

export interface EntityActionsToolbarProps {
  typeId: TypeId;
  /** Display label for the favorite tile when the user toggles it on. */
  favoriteTitle: string;
  /** Optional icon key persisted on the bookmark.data; the home desktop grid uses it. */
  favoriteIcon?: string;
  /**
   * 'prominent' renders Share as a labeled pill.
   * 'compact' (default) renders every action as a same-sized icon button.
   */
  variant?: Variant;
  /** Slot for caller-supplied extra trailing actions (e.g. <ExportEntityButton>). */
  trailing?: React.ReactNode;
  onShared?: () => void;
  className?: string;
}

/**
 * Generic Share + Favorite toolbar — drop into any entity surface.
 *
 *   <EntityActionsToolbar typeId={process.typeId} favoriteTitle="My session" variant="prominent" />
 *
 * Share opens the ShareToConversationDialog. Favorite is the existing FavoriteStar
 * — persists a Bookmark(bookmark_type=favorite) that the homepage MiniDesktop
 * renders. For export/download, compose <ExportEntityButton> (e.g. via `trailing`).
 */
export function EntityActionsToolbar({
  typeId,
  favoriteTitle,
  favoriteIcon,
  variant = 'compact',
  trailing,
  onShared,
  className,
}: EntityActionsToolbarProps) {
  const [shareOpen, setShareOpen] = useState(false);
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

  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      <ShareButton
        variant={variant}
        onClick={() => setShareOpen(true)}
        disabled={!canShare}
        tooltip={canShare ? (variant === 'prominent' ? 'Share to a conversation' : 'Share') : 'Loading…'}
        testId="entity-actions-share"
      />

      <FavoriteStar
        entityType={typeId.type}
        entityId={typeId.id}
        title={favoriteTitle}
        icon={favoriteIcon}
        size={variant === 'prominent' ? 16 : 14}
        className={
          variant === 'compact'
            ? `${compactEntityActionClassName} p-0`
            : undefined
        }
      />

      {trailing}

      {shareOpen && (
        <ShareToConversationDialog
          open={shareOpen}
          onClose={handleClose}
          source={shareSource}
        />
      )}
    </div>
  );
}
