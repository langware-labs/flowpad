import { File, FileText, Image, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';

export interface FileUploadItem {
  id: string;
  file: File;
  isUploading: boolean;
  uploadProgress?: number;
  thumbnailUrl?: string;
  error?: string;
}

interface FileUploadIndicatorProps {
  files: FileUploadItem[];
  onRemoveFile?: (fileId: string) => void;
}

function getFileIcon(fileType: string, fileName: string) {
  if (fileType.startsWith('image/')) {
    return <Image className="h-4 w-4" />;
  }

  if (fileType === 'text/plain' || fileName.endsWith('.txt')) {
    return <FileText className="h-4 w-4" />;
  }

  return <File className="h-4 w-4" />;
}

function createThumbnail(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) {
      resolve(null);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new window.Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        const size = 32;
        canvas.width = size;
        canvas.height = size;

        if (ctx) {
          ctx.drawImage(img, 0, 0, size, size);
          resolve(canvas.toDataURL());
        } else {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = e.target?.result as string;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function FileItem({ fileItem, onRemove }: { fileItem: FileUploadItem; onRemove?: (fileId: string) => void }) {
  const { t } = useLingui();
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(fileItem.thumbnailUrl || null);

  useEffect(() => {
    if (!thumbnailUrl && fileItem.file.type.startsWith('image/')) {
      void createThumbnail(fileItem.file).then(setThumbnailUrl);
    }
  }, [fileItem.file, thumbnailUrl]);

  const handleRemove = useCallback(() => {
    onRemove?.(fileItem.id);
  }, [fileItem.id, onRemove]);

  return (
    <div className="inline-flex items-center gap-1 rounded-md border bg-muted/30 px-2 py-1 text-xs">
      <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded">
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt={fileItem.file.name} className="h-4 w-4 rounded object-cover" />
        ) : (
          <div className="flex h-4 w-4 items-center justify-center">
            {getFileIcon(fileItem.file.type, fileItem.file.name)}
          </div>
        )}
      </div>

      <span
        className="max-w-20 truncate font-medium"
        title={`${fileItem.file.name} (${(fileItem.file.size / 1024).toFixed(1)} KB)`}
      >
        {fileItem.file.name}
      </span>

      {fileItem.error && (
        <span className="text-destructive" title={fileItem.error}>
          ⚠
        </span>
      )}

      {fileItem.isUploading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}

      <button className="ml-1 text-muted-foreground hover:text-destructive" onClick={handleRemove} title={t`Remove file`}>
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export function FileUploadIndicator({ files, onRemoveFile }: FileUploadIndicatorProps) {
  if (files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1 px-1 py-1">
      {files.map((fileItem) => (
        <FileItem key={fileItem.id} fileItem={fileItem} onRemove={onRemoveFile} />
      ))}
    </div>
  );
}
