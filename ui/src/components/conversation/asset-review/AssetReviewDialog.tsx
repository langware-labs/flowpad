import { MessageAttachment, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useMemo } from 'react';
import { Trans } from '@lingui/react/macro';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { File } from 'lucide-react';
import { iconForEntity } from '../EntityChip';
import { AssetInstallActions } from './AssetInstallActions';
import { StagedAssetViewer } from './StagedAssetViewer';

/**
 * Review modal for a received, staged bundle attachment (opened from the
 * dashed conversation chip). Shows the staged content read-only plus the
 * install header: Install in project / Install global / Uninstall / Run.
 *
 * The header flips live off the MessageAttachment UPDATE (its scope), via the
 * `liveAttachment` subscription below — no optimistic writes anywhere.
 */
export function AssetReviewDialog({
  open,
  onClose,
  attachment,
  targetTypeId,
  attachmentProjectId,
}: {
  open: boolean;
  onClose: () => void;
  attachment: MessageAttachment;
  targetTypeId: TypeId;
  attachmentProjectId: string | null;
}) {
  // Live MessageAttachment subscription: the `attachment` prop rides the
  // conversation-wide QUERY, and WS UPDATE ops don't notify query watchers —
  // without this, installing from the open modal leaves the header buttons
  // stale ("Install" instead of "Uninstall") until a remount.
  const maTypeId = useMemo(
    () => (open && attachment.id ? new TypeId(MessageAttachment.type, attachment.id) : null),
    [open, attachment.id],
  );
  const { data: liveAttachment } = useEntity<MessageAttachment>(maTypeId);
  const ma = liveAttachment ?? attachment;
  // Raw files have no backend TypeInfo icon — use the generic File glyph
  // (sanctioned call-site special-case, mirroring FlowMessageBubble's chip).
  const Icon = targetTypeId.type === 'file' ? File : iconForEntity(targetTypeId.type);
  const typeWord =
    targetTypeId.type.charAt(0).toUpperCase() + targetTypeId.type.slice(1).replace(/_/g, ' ');

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl" data-testid="asset-review-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate">{ma.name ?? typeWord}</span>
            <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
              {typeWord}
            </span>
          </DialogTitle>
          {ma.description ? (
            <DialogDescription>{ma.description}</DialogDescription>
          ) : (
            <DialogDescription>
              <Trans>Received attachment — review before installing.</Trans>
            </DialogDescription>
          )}
        </DialogHeader>
        <AssetInstallActions
          attachment={ma}
          conversationProjectId={attachmentProjectId}
        />
        <div className="border-t border-border pt-3">
          <StagedAssetViewer attachment={ma} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
