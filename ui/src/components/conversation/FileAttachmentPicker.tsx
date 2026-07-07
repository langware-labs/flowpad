import { useEffect, useId, useState } from 'react';
import { Paperclip, X, File } from 'lucide-react';
import { cn } from '@src/lib/utils';
import { isImageFile } from '@src/utils/clipboard-image';
import { MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_LABEL } from './constants';

interface FileAttachmentPickerProps {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One picked-file row. Image files preview as a thumbnail from an object URL
 * (mirrors the composer's PendingFileChip) so an attached image reads as an
 * image, not a nameless binary; everything else shows a small file icon.
 */
export function PickedFileRow({
  file,
  disabled,
  onRemove,
}: {
  file: File;
  disabled?: boolean;
  onRemove: () => void;
}) {
  const image = isImageFile(file);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!image || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, image]);

  return (
    <li
      className={cn(
        'flex items-center gap-2 rounded-md border border-input bg-muted/40 text-xs',
        image ? 'p-1.5' : 'px-2 py-1',
      )}
    >
      {image ? (
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-background">
          {previewUrl ? (
            <img src={previewUrl} alt={file.name} className="h-full w-full object-contain" />
          ) : (
            <File className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      ) : (
        <File className="h-3 w-3 shrink-0 text-muted-foreground" />
      )}
      <span className="flex-1 truncate text-foreground" title={file.name}>
        {file.name}
      </span>
      <span className="shrink-0 text-muted-foreground">{formatSize(file.size)}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        disabled={disabled}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive disabled:pointer-events-none"
      >
        <X className="h-3 w-3" />
      </button>
    </li>
  );
}

/**
 * Size-guarded, deduped merge of incoming files into an existing selection.
 * Returns the merged list plus the names that were rejected for size, so any
 * composer can share the same attach semantics and format (or localize) the
 * rejection copy itself.
 */
export function mergePickedFiles(
  existing: File[],
  incoming: FileList | File[] | null,
): { files: File[]; rejectedNames: string[] } {
  if (!incoming) return { files: existing, rejectedNames: [] };
  const next = [...existing];
  const rejectedNames: string[] = [];
  for (const f of Array.from(incoming)) {
    if (f.size > MAX_FILE_SIZE_BYTES) {
      rejectedNames.push(f.name);
      continue;
    }
    if (!next.some((x) => x.name === f.name && x.size === f.size)) {
      next.push(f);
    }
  }
  return { files: next, rejectedNames };
}

/** Default (unlocalized) rejection copy for `mergePickedFiles` results. */
export function rejectedFilesNotice(rejectedNames: string[]): string | null {
  if (rejectedNames.length === 0) return null;
  return rejectedNames.length === 1
    ? `"${rejectedNames[0]}" is over ${MAX_FILE_SIZE_LABEL} and was not attached.`
    : `${rejectedNames.length} files over ${MAX_FILE_SIZE_LABEL} were not attached: ${rejectedNames.join(', ')}.`;
}

export function FileAttachmentPicker({ files, onChange, disabled }: FileAttachmentPickerProps) {
  const inputId = useId();
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const merged = mergePickedFiles(files, incoming);
    setRejected(rejectedFilesNotice(merged.rejectedNames));
    onChange(merged.files);
  };

  const remove = (index: number) => {
    onChange(files.filter((_, i) => i !== index));
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!disabled) setDragging(true);
  };

  const onDragLeave = () => setDragging(false);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!disabled) addFiles(e.dataTransfer.files);
  };

  return (
    <div className="space-y-1.5">
      {/* Drop zone is a <label htmlFor> so a real native click on the
          hidden file input opens the OS picker reliably — even inside a
          Radix Dialog portal where a synthetic onClick on a div sometimes
          doesn't propagate down to inputRef.current.click(). */}
      <label
        htmlFor={inputId}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          'flex cursor-pointer items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground transition-colors',
          dragging
            ? 'border-primary bg-primary/5 text-primary'
            : 'border-input hover:border-muted-foreground/50 hover:text-foreground',
          disabled && 'pointer-events-none opacity-50',
        )}
      >
        <Paperclip className="h-3.5 w-3.5 shrink-0" />
        <span>
          {dragging ? 'Drop files here' : `Attach files — drag & drop or click to browse (max ${MAX_FILE_SIZE_LABEL})`}
        </span>
      </label>

      <input
        id={inputId}
        type="file"
        multiple
        className="sr-only"
        disabled={disabled}
        onChange={(e) => addFiles(e.target.files)}
        onClick={(e) => ((e.target as HTMLInputElement).value = '')}
      />

      {rejected && <p className="text-[11px] text-destructive">{rejected}</p>}

      {/* File list */}
      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((f, i) => (
            <PickedFileRow key={i} file={f} disabled={disabled} onRemove={() => remove(i)} />
          ))}
        </ul>
      )}
    </div>
  );
}
