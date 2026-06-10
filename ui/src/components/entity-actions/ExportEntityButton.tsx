import { useState } from 'react';
import { Download, Link2 } from 'lucide-react';
import { TypeId } from '@sdk';
import { EntityShareDialog } from '@src/components/terminal/interactive-terminal/EntityShareDialog';
import { useEntityShare } from '@src/hooks/use-entity-share';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';

export interface ExportEntityButtonProps {
  typeId: TypeId;
  /** Title prefilled into the export/share bundle dialog. */
  defaultTitle: string;
  /** Surface-level opt-in for the "Copy link" mode (Link2 icon). Defaults to false. */
  allowCopyLink?: boolean;
  className?: string;
}

/**
 * Standalone export/download button + its EntityShareDialog (send / copy link /
 * download bundle). Split out of EntityActionsToolbar so it can live wherever a
 * layout wants it — e.g. the interactive tab header's right toolbar rather than
 * the center Share/Bookmark group.
 */
export function ExportEntityButton({ typeId, defaultTitle, allowCopyLink = false, className }: ExportEntityButtonProps) {
  const [exportOpen, setExportOpen] = useState(false);
  const { canShare } = useEntityShare(typeId);

  const exportLabel = allowCopyLink ? 'Copy link or download bundle' : 'Download bundle';

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setExportOpen(true)}
            disabled={!canShare}
            className={cn(
              'inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent',
              'disabled:cursor-not-allowed disabled:opacity-50',
              className,
            )}
            data-testid="entity-actions-export"
            aria-label={exportLabel}
          >
            {allowCopyLink ? <Link2 className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {exportLabel}
        </TooltipContent>
      </Tooltip>

      {exportOpen && (
        <EntityShareDialog
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          typeId={typeId}
          defaultTitle={defaultTitle}
          allowCopyLink={allowCopyLink}
        />
      )}
    </>
  );
}
