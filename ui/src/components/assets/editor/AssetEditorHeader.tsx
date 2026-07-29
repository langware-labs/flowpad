import React from 'react';
import { Download, ExternalLink, FolderOpen, Trash2 } from 'lucide-react';
import { ProjectNameChip } from '@src/components/assets/ProjectNameChip';
import { useIsAdvanced } from '@src/components/view-mode';
import { useLingui } from '@lingui/react/macro';
import { AssetCollisionBadge, useAssetCollisionEntity } from './AssetCollisionUI';

export interface AssetEditorHeaderProps {
  /** Filename or folder name used to resolve the owning project. */
  fileName: string;
  /** Parent directory used to resolve the owning project. */
  dirPath: string;
  /** Absolute path of the asset; used to resolve the owning project chip. */
  sourcePath?: string;
  /** Adds a yellow asterisk after the filename for unsaved-changes signal. */
  dirty?: boolean;
  /** "Open externally" — open the asset in the OS default app via fsRef.open(). */
  onOpenExternal?: () => void;
  /** "Reveal in Finder" — show the asset selected in its parent folder via fsRef.open({ select: true }). */
  onRevealInFinder?: () => void;
  /** Optional download-to-disk button. */
  onDownload?: () => void;
  /** Optional delete button. */
  onDelete?: () => void;
  /** Right-side slot for editor-specific actions (mode chips, export buttons, etc.). */
  actions?: React.ReactNode;
}

/**
 * Shared header for asset editors (markdown, whiteboard, …).
 *
 * The page header owns asset identity (type icon, name, path). This compact
 * secondary row contains only editor/file controls:
 *
 *   Open externally — opens the file in its default OS app
 *   Reveal in Finder — selects the file in its parent folder
 *   Download — saves the file to disk
 *   Delete — removes the asset
 *
 * Editor-specific controls (view-mode chips, import/export buttons) go in
 * the `actions` slot on the right.
 */
export function AssetEditorHeader({
  fileName,
  dirPath,
  sourcePath,
  dirty,
  onOpenExternal,
  onRevealInFinder,
  onDownload,
  onDelete,
  actions,
}: AssetEditorHeaderProps) {
  const { t } = useLingui();
  const advanced = useIsAdvanced();
  const collisionEntity = useAssetCollisionEntity();
  const resolvedPath = sourcePath ?? (dirPath ? `${dirPath}/${fileName}` : fileName);
  const hasCollision = (collisionEntity?.duplicate_count ?? 0) > 0;
  const hasControls =
    advanced ||
    dirty ||
    hasCollision ||
    !!onDelete ||
    !!actions;
  if (!hasControls) return null;
  return (
    <div
      className="flex h-10 flex-shrink-0 items-center gap-2 border-b px-3"
      data-testid="asset-editor-header"
    >
      <AssetCollisionBadge />
      {dirty && <span className="text-sm text-amber-500" title={t`Unsaved changes`}>*</span>}
      {advanced && <ProjectNameChip sourcePath={resolvedPath} />}
      <div className="ml-auto flex flex-shrink-0 items-center gap-1">
        {advanced && onOpenExternal && (
          <button
            type="button"
            title={t`Open externally`}
            onClick={onOpenExternal}
            data-testid="asset-editor-open-external"
            className="flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        )}
        {advanced && onRevealInFinder && (
          <button
            type="button"
            title={t`Reveal in Finder`}
            onClick={onRevealInFinder}
            data-testid="asset-editor-reveal"
            className="flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </button>
        )}
        {advanced && onDownload && (
          <button
            type="button"
            title={t`Download file`}
            onClick={onDownload}
            data-testid="asset-editor-download"
            className="flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            title={t`Delete`}
            onClick={onDelete}
            data-testid="asset-editor-delete"
            className="flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        {actions}
      </div>
    </div>
  );
}
