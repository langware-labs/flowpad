import React from 'react';
import { Download, ExternalLink, FolderOpen, Trash2 } from 'lucide-react';

export interface AssetEditorHeaderProps {
  /** Filename or folder name shown on the top line. */
  fileName: string;
  /** Parent directory path shown beneath the name (truncated). */
  dirPath: string;
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
 * Renders the file name + parent directory path on the left, with a row of
 * file-management icon buttons beneath the path:
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
  dirty,
  onOpenExternal,
  onRevealInFinder,
  onDownload,
  onDelete,
  actions,
}: AssetEditorHeaderProps) {
  return (
    <div className="flex h-[52px] flex-shrink-0 items-center gap-2 border-b px-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-0.5 truncate">
          <span className="text-sm font-medium">{fileName}</span>
          {dirty && <span className="text-sm text-amber-500">*</span>}
        </div>
        <div className="flex min-w-0 items-center gap-1">
          {dirPath && (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">{dirPath}</span>
          )}
          {onOpenExternal && (
            <button
              title="Open externally"
              onClick={onOpenExternal}
              data-testid="asset-editor-open-external"
              className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
            </button>
          )}
          {onRevealInFinder && (
            <button
              title="Reveal in Finder"
              onClick={onRevealInFinder}
              data-testid="asset-editor-reveal"
              className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <FolderOpen className="h-3 w-3" />
            </button>
          )}
          {onDownload && (
            <button
              title="Download file"
              onClick={onDownload}
              data-testid="asset-editor-download"
              className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Download className="h-3 w-3" />
            </button>
          )}
          {onDelete && (
            <button
              title="Delete"
              onClick={onDelete}
              data-testid="asset-editor-delete"
              className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {actions && <div className="flex flex-shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}
