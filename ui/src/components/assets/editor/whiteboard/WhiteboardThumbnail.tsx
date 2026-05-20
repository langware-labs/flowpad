import { useEffect, useState } from 'react';
import { FSRef } from '@sdk';

interface WhiteboardThumbnailProps {
  /** FSRef to the whiteboard folder. */
  fsRef: FSRef;
  /** Optional alt text. */
  alt?: string;
  /** CSS class applied to the rendered image / placeholder. */
  className?: string;
}

/**
 * Read-only preview for a whiteboard. Loads `thumbnail.svg` from the folder
 * if it exists; otherwise renders a Palette placeholder. Used by tree-row
 * previews and `![[name]]` transclusion.
 */
export function WhiteboardThumbnail({ fsRef, alt, className }: WhiteboardThumbnailProps) {
  const [svgUrl, setSvgUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    const thumbRef = fsRef.child('thumbnail.svg');
    (async () => {
      try {
        const svg = await thumbRef.read();
        if (cancelled) return;
        const blob = new Blob([svg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        createdUrl = url;
        setSvgUrl(url);
      } catch {
        if (cancelled) return;
        setSvgUrl(null);
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
    // fsRef is typically freshly constructed each parent render — track its path string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fsRef.path]);

  if (!svgUrl) {
    return (
      <div
        data-testid="whiteboard-thumbnail-placeholder"
        className={className ?? 'flex h-full w-full items-center justify-center text-xs text-muted-foreground'}
      >
        Whiteboard
      </div>
    );
  }
  return (
    <img
      data-testid="whiteboard-thumbnail"
      src={svgUrl}
      alt={alt ?? 'Whiteboard thumbnail'}
      className={className ?? 'h-full w-full object-contain'}
    />
  );
}

export default WhiteboardThumbnail;
