import { FileArchive, Upload } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

interface DragDropOverlayProps {
  zipFileEnabled: boolean;
  onFilesDrop: (files: FileList) => void;
}

export function DragDropOverlay({ zipFileEnabled, onFilesDrop }: DragDropOverlayProps) {
  const [, setDragCounter] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Check if files are being dragged using dataTransfer.types
    const hasFiles = e.dataTransfer?.types?.includes('Files');

    if (hasFiles) {
      setDragCounter((prev) => {
        const newCounter = prev + 1;
        if (newCounter === 1) {
          setIsDragOver(true);
        }
        return newCounter;
      });
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    setDragCounter((prev) => {
      const newCounter = prev - 1;
      if (newCounter <= 0) {
        setIsDragOver(false);
        return 0;
      }
      return newCounter;
    });
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      setDragCounter(0);
      setIsDragOver(false);

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      onFilesDrop(files);
    },
    [onFilesDrop],
  );

  useEffect(() => {
    document.body.addEventListener('dragenter', handleDragEnter);
    document.body.addEventListener('dragleave', handleDragLeave);
    document.body.addEventListener('dragover', handleDragOver);
    document.body.addEventListener('drop', handleDrop);

    return () => {
      document.body.removeEventListener('dragenter', handleDragEnter);
      document.body.removeEventListener('dragleave', handleDragLeave);
      document.body.removeEventListener('dragover', handleDragOver);
      document.body.removeEventListener('drop', handleDrop);
    };
  }, [handleDragEnter, handleDragLeave, handleDragOver, handleDrop]);

  if (!isDragOver) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="mx-4 max-w-md rounded-lg border-2 border-dashed border-primary bg-background p-12 text-center">
        <div className="mb-4 flex justify-center">
          {zipFileEnabled ? (
            <div className="flex gap-4">
              <Upload className="h-12 w-12 text-primary" />
              <FileArchive className="h-12 w-12 text-primary" />
            </div>
          ) : (
            <Upload className="h-12 w-12 text-primary" />
          )}
        </div>

        <h3 className="mb-2 text-xl font-semibold">Drop files here</h3>

        <p className="mb-4 text-muted-foreground">
          {zipFileEnabled
            ? 'Supported: ZIP, Text, PDF, Images (PNG, JPEG, GIF, WebP, HEIC)'
            : 'Supported: Text, PDF, Images (PNG, JPEG, GIF, WebP, HEIC)'}
        </p>

        {zipFileEnabled && (
          <p className="text-sm text-muted-foreground">ZIP files will be added as codebase connections</p>
        )}
      </div>
    </div>
  );
}
