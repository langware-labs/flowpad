import { useId, useState } from 'react';
import { Paperclip, X, File } from 'lucide-react';
import { cn } from '@src/lib/utils';
import { MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_LABEL } from './constants';

interface FileAttachmentPickerProps {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}

export function FileAttachmentPicker({ files, onChange, disabled }: FileAttachmentPickerProps) {
  const inputId = useId();
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const next = [...files];
    const tooBig: string[] = [];
    for (const f of Array.from(incoming)) {
      if (f.size > MAX_FILE_SIZE_BYTES) {
        tooBig.push(f.name);
        continue;
      }
      if (!next.some((x) => x.name === f.name && x.size === f.size)) {
        next.push(f);
      }
    }
    if (tooBig.length > 0) {
      setRejected(
        tooBig.length === 1
          ? `"${tooBig[0]}" is over ${MAX_FILE_SIZE_LABEL} and was not attached.`
          : `${tooBig.length} files over ${MAX_FILE_SIZE_LABEL} were not attached: ${tooBig.join(', ')}.`,
      );
    } else {
      setRejected(null);
    }
    onChange(next);
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
            <li
              key={i}
              className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-2 py-1 text-xs"
            >
              <File className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate text-foreground" title={f.name}>
                {f.name}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {f.size < 1024
                  ? `${f.size} B`
                  : f.size < 1024 * 1024
                    ? `${(f.size / 1024).toFixed(1)} KB`
                    : `${(f.size / (1024 * 1024)).toFixed(1)} MB`}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(i);
                }}
                disabled={disabled}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive disabled:pointer-events-none"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
