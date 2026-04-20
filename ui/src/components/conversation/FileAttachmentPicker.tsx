import { useRef, useState } from 'react';
import { Paperclip, X, File } from 'lucide-react';
import { cn } from '@src/lib/utils';

interface FileAttachmentPickerProps {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}

export function FileAttachmentPicker({ files, onChange, disabled }: FileAttachmentPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const next = [...files];
    for (const f of Array.from(incoming)) {
      if (!next.some((x) => x.name === f.name && x.size === f.size)) {
        next.push(f);
      }
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
      {/* Drop zone / picker button */}
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => !disabled && inputRef.current?.click()}
        className={cn(
          'flex cursor-pointer items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground transition-colors',
          dragging
            ? 'border-primary bg-primary/5 text-primary'
            : 'border-input hover:border-muted-foreground/50 hover:text-foreground',
          disabled && 'pointer-events-none opacity-50',
        )}
      >
        <Paperclip className="h-3.5 w-3.5 shrink-0" />
        <span>{dragging ? 'Drop files here' : 'Attach files — drag & drop or click to browse'}</span>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        disabled={disabled}
        onChange={(e) => addFiles(e.target.files)}
        onClick={(e) => ((e.target as HTMLInputElement).value = '')}
      />

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
                onClick={(e) => { e.stopPropagation(); remove(i); }}
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
