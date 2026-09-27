import { type TypeId, isImagePath } from '@sdk';
import { fsStore } from '@sdk';
import { openExternalFromComputeNode } from '@sdk/entities/compute-node';
import {
  Check,
  ClipboardPaste,
  Copy,
  ExternalLink,
  File,
  FolderSearch,
  RefreshCw,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import React, { useState, useEffect } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { useCopied } from '@src/components/ui/copy-button';
import { Dialog, DialogContent } from '@src/components/ui/dialog';
import { useFS } from '@src/hooks/useFS';
import { cn } from '@src/lib/utils';

interface InputFilesPanelProps {
  computeNodeTypeId: TypeId;
  inputDirAbsPath: string;
  /** Insert a file's path into the input the user is typing in (composer or PTY), at the cursor. */
  onInsertPath?: (path: string) => void;
}

interface RowActionProps {
  label: string;
  title: string;
  icon: LucideIcon;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
}

/** Hover-revealed icon button on a file row; never triggers the row's own click. */
const RowAction: React.FC<RowActionProps> = ({ label, title, icon: Icon, onClick, className, disabled }) => (
  <Button
    variant="ghost"
    size="sm"
    className={cn('h-6 w-6 shrink-0 p-0 opacity-0 transition-opacity group-hover:opacity-100', className)}
    aria-label={label}
    title={title}
    disabled={disabled}
    onClick={(e) => {
      e.stopPropagation();
      onClick();
    }}
  >
    <Icon className="h-3.5 w-3.5" />
  </Button>
);

const CopyPathAction: React.FC<{ name: string; path: string }> = ({ name, path }) => {
  const { t } = useLingui();
  const { copied, copy } = useCopied();
  return (
    <RowAction
      label={t`Copy path of ${name}`}
      title={t`Copy path`}
      icon={copied ? Check : Copy}
      onClick={() => void copy(path)}
    />
  );
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const InputFilesPanel: React.FC<InputFilesPanelProps> = ({
  computeNodeTypeId,
  inputDirAbsPath,
  onInsertPath,
}) => {
  const { t } = useLingui();
  const fs = useFS(computeNodeTypeId);
  const fsRef = React.useRef(fs);
  fsRef.current = fs;
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);

  const browseResult = fs?.browse(inputDirAbsPath);
  const items = browseResult?.items ?? [];

  // Fetch whenever the cache has no entry for this path. This covers initial
  // mount and any later invalidation triggered by upload/delete elsewhere in
  // the app — listDirectory dedupes concurrent calls, so spurious fires are
  // cheap. fs is read via ref because useFS returns a new object each render.
  useEffect(() => {
    if (browseResult) return;
    void fsRef.current?.listDirectory(inputDirAbsPath);
  }, [browseResult, inputDirAbsPath]);

  const handleRefresh = () => {
    if (!fs) return;
    fs.invalidate(inputDirAbsPath, 'browse');
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.stopPropagation();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    const uploads = await fsStore.getState().uploadFiles(computeNodeTypeId, inputDirAbsPath, files);
    await Promise.all(uploads.map((u) => u.waitForCompletion()));
  };

  const handleDelete = async (path: string) => {
    if (!fs) return;
    setDeletingPath(path);
    try {
      await fs.delete(path);
    } finally {
      setDeletingPath(null);
    }
  };

  return (
    <div
      className={`flex flex-1 flex-col overflow-hidden transition-colors ${isDragOver ? 'bg-muted/40 ring-1 ring-inset ring-primary/40' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(e) => {
        void handleDrop(e);
      }}
    >
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">
          <Trans>Input Files</Trans>
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void openExternalFromComputeNode(computeNodeTypeId.id, inputDirAbsPath)}
            className="h-6 w-6 p-0"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={handleRefresh} className="h-6 w-6 p-0">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {items.length === 0 ? (
          <p className="mt-4 px-2 text-center text-xs text-muted-foreground">
            <Trans>Paste or drag files here</Trans>
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {items.map((item) => {
              const itemPath = `${inputDirAbsPath}/${item.name}`;
              // getDownloadUrl takes an ENTITY-RELATIVE path — it prepends
              // `compute_node/<id>/fs/download/` itself. `vfs_abs_path` already
              // carries that `compute_node-<id>/` prefix, so passing it doubled
              // the entity segment and every thumbnail 404'd.
              const downloadUrl = fs?.getDownloadUrl(item.relativePath || itemPath);
              const isImage = isImagePath(item.name);
              const isDeleting = deletingPath === itemPath;
              return (
                <div
                  key={item.name}
                  className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${isImage ? 'cursor-pointer hover:bg-muted' : 'hover:bg-muted/50'} ${isDeleting ? 'opacity-50' : ''}`}
                  onClick={isImage && downloadUrl ? () => setSelectedImage(downloadUrl) : undefined}
                >
                  {isImage && downloadUrl ? (
                    <img src={downloadUrl} alt={item.name} className="h-12 w-12 shrink-0 rounded object-cover" />
                  ) : (
                    <File className="h-5 w-5 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{item.name}</p>
                    {item.size !== undefined && (
                      <p className="text-[10px] text-muted-foreground">{formatSize(item.size)}</p>
                    )}
                  </div>
                  {onInsertPath && (
                    <RowAction
                      label={t`Paste path of ${item.name}`}
                      title={t`Paste path at cursor`}
                      icon={ClipboardPaste}
                      onClick={() => onInsertPath(itemPath)}
                    />
                  )}
                  <CopyPathAction name={item.name} path={itemPath} />
                  <RowAction
                    label={t`Reveal ${item.name} in Finder/Explorer`}
                    title={t`Reveal in Finder/Explorer`}
                    icon={FolderSearch}
                    onClick={() => void openExternalFromComputeNode(computeNodeTypeId.id, itemPath, { select: true })}
                  />
                  <RowAction
                    label={`Delete ${item.name}`}
                    title={`Delete ${item.name}`}
                    icon={Trash2}
                    className="hover:text-destructive"
                    disabled={isDeleting}
                    onClick={() => void handleDelete(itemPath)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Dialog
        open={!!selectedImage}
        onOpenChange={(open) => {
          if (!open) setSelectedImage(null);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-[90vw] p-2">
          {selectedImage && (
            <img src={selectedImage} alt={t`Preview`} className="max-h-[85vh] max-w-full rounded object-contain" />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};
