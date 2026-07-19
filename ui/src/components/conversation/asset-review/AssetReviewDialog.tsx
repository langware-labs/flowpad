import { MessageAttachment, TypeId } from '@sdk';
import { gitOriginCloneUrl, type GitOrigin } from '@sdk/models/GitOrigin';
import { useEntity } from '@sdk/react/hooks';
import { useMemo } from 'react';
import { Trans } from '@lingui/react/macro';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Cloud, ExternalLink, File, GitBranch, Package } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { buildDockPointer, iconForEntity } from '../EntityChip';
import { AssetInstallActions } from './AssetInstallActions';
import { StagedAssetViewer } from './StagedAssetViewer';

/** Where the asset's content actually comes from — the reviewer's trust signal.
 *  Derived from the MA row: a git transfer carries only the remote (installing
 *  clones/pulls it); staged bytes rode inside the .flowmsg; anything else is a
 *  hub-served reference fetched on open. */
function sourceOf(ma: MessageAttachment): { label: string; Icon: typeof Cloud; detail: string | null } {
  const origin = (ma.git_origin ?? null) as GitOrigin | null;
  if (ma.transfer_mode === 'git' || origin) {
    return { label: 'Git', Icon: GitBranch, detail: origin ? gitOriginCloneUrl(origin) : null };
  }
  if (ma.unpacked_path) return { label: 'Embedded in message', Icon: Package, detail: null };
  return { label: 'Cloud', Icon: Cloud, detail: null };
}

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
  const { navigation } = useDockNavigation();
  // Advanced-mode affordance: once the asset is installed its entity exists, so
  // the review modal offers a jump to its real view (e.g. the task view) next
  // to Uninstall. Staged/not-yet-installed → nothing to open, so it's hidden.
  const installed = ma.effectiveScope != null;
  const openEntity = () => {
    if (!targetTypeId.id) return;
    const pointer = buildDockPointer({ type: targetTypeId.type, id: targetTypeId.id }, undefined);
    if (pointer) navigation.openDock(DockPointer.rebaseAssetsOntoProject(pointer, attachmentProjectId));
    onClose();
  };
  // Raw files have no backend TypeInfo icon — use the generic File glyph
  // (sanctioned call-site special-case, mirroring FlowMessageBubble's chip).
  const Icon = targetTypeId.type === 'file' ? File : iconForEntity(targetTypeId.type);
  const typeWord = targetTypeId.type.charAt(0).toUpperCase() + targetTypeId.type.slice(1).replace(/_/g, ' ');

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
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
          <SourceRow ma={ma} />
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <AssetInstallActions attachment={ma} conversationProjectId={attachmentProjectId} />
          {installed && (
            <Button size="sm" variant="secondary" onClick={openEntity} data-testid="asset-open-entity">
              <ExternalLink className="h-3.5 w-3.5" />
              <Trans>Open</Trans>
            </Button>
          )}
        </div>
        <div className="border-t border-border pt-3">
          <StagedAssetViewer attachment={ma} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Provenance line under the title: where installing pulls the content from. */
function SourceRow({ ma }: { ma: MessageAttachment }) {
  const { label, Icon, detail } = sourceOf(ma);
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground" data-testid="asset-review-source">
      <Icon className="h-3 w-3 shrink-0" />
      <span>
        <Trans>Source:</Trans> {label}
      </span>
      {detail && <span className="truncate font-mono text-[10px]">{detail}</span>}
    </div>
  );
}
