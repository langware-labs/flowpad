import { APIEntity, MessageAttachment, TypeId } from '@sdk';
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
import { iconForEntity } from '../EntityChip';
import { AssetInstallActions } from './AssetInstallActions';
import { StagedAssetViewer } from './StagedAssetViewer';

/**
 * Review modal for a received, staged bundle attachment (opened from the
 * dashed conversation chip). Shows the staged content read-only plus the
 * install header: Install in project / Install global / Uninstall / Test it.
 *
 * The header flips live: `useEntity(targetTypeId)` resolving means the asset
 * was installed (its CREATE data-op landed), and the MessageAttachment UPDATE
 * carries the scope — no optimistic writes anywhere.
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: installedEntity } = useEntity<APIEntity<any>>(open ? targetTypeId : null);
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
  const Icon = iconForEntity(targetTypeId.type);
  const typeWord =
    targetTypeId.type.charAt(0).toUpperCase() + targetTypeId.type.slice(1).replace(/_/g, ' ');
  const installedAssetRef =
    (installedEntity as unknown as { asset_ref?: string | null } | null)?.asset_ref ?? null;

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
          installedAssetRef={installedAssetRef}
          conversationProjectId={attachmentProjectId}
        />
        <div className="border-t border-border pt-3">
          <StagedAssetViewer attachment={ma} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
