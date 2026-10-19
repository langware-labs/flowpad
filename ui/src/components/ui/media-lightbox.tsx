import { t } from '@lingui/core/macro';
import { Check, Copy, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { isImagePath } from '@sdk';
import { notify } from '@src/notifications';

const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'webm', 'ogv', 'ogg']);
const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  // `.mov` is the QuickTime container, but it's ISO-BMFF just like `.mp4` — an
  // H.264/AAC `.mov` plays in Chrome/Chromium IFF the <source> is labeled
  // `video/mp4`. `video/quicktime` makes Chrome reject it outright
  // (`canPlayType('video/quicktime') === ''`), so the preview fell back to a
  // file icon. (Chrome guidance: never use `type=video/quicktime` for `.mov`.)
  // HEVC/ProRes `.mov` still can't decode and falls through to the icon.
  mov: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
};

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function isVideoPath(name: string): boolean {
  return VIDEO_EXTS.has(extOf(name));
}

/** Whether `MediaLightbox` can show this file (by name). */
export function isLightboxMedia(name: string): boolean {
  return isImagePath(name) || isVideoPath(name);
}

// A <source> for a video url, typed by extension when we recognise it.
export function videoSource(url: string, name: string) {
  const mime = VIDEO_MIME[extOf(name)];
  return mime ? <source src={url} type={mime} /> : <source src={url} />;
}

// The clipboard only reliably takes PNG, so anything else is re-encoded
// through a canvas first.
async function imageAsPng(url: string): Promise<Blob> {
  const blob = await (await fetch(url)).blob();
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('PNG encode failed'))), 'image/png'),
  );
}

interface MediaLightboxProps {
  url: string;
  /** File name — picks image vs video and labels the dialog. */
  name: string;
  onClose: () => void;
}

const FRAME_BUTTON =
  'flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * In-app preview for an image or video, in a rounded, heavily bordered frame
 * with a Close button and (for images) Copy to clipboard. Backdrop click + Esc
 * close; clicking inside the frame does not. Portalled to `body` so a host
 * with a transform or overflow clip (a terminal pane, a chat bubble) can't trap it.
 */
export function MediaLightbox({ url, name, onClose }: MediaLightboxProps) {
  const [copied, setCopied] = useState(false);
  const isVideo = isVideoPath(name);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copyImage = useCallback(async () => {
    try {
      // ClipboardItem takes the Promise<Blob>, so write() runs inside the click
      // gesture while the PNG is still being produced.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': imageAsPng(url) })]);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      notify.error({ title: t`Clipboard not updated`, message: t`The image could not be copied to the clipboard.` });
    }
  }, [url]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      data-testid="media-lightbox"
      onClick={onClose}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/70 p-6 backdrop-blur-sm"
    >
      <div
        data-testid="media-lightbox-frame"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full max-w-full flex-col overflow-hidden rounded-2xl border-4 border-border bg-card text-card-foreground shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b-2 border-border px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={name}>
            {name}
          </span>
          {!isVideo && (
            <button
              type="button"
              onClick={() => void copyImage()}
              title={t`Copy image to clipboard`}
              aria-label={t`Copy image to clipboard`}
              data-testid="media-lightbox-copy"
              className={FRAME_BUTTON}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? t`Copied` : t`Copy`}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title={t`Close`}
            aria-label={t`Close`}
            data-testid="media-lightbox-close"
            className={FRAME_BUTTON}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/40">
          {isVideo ? (
            <video controls autoPlay playsInline className="max-h-[calc(100vh-7rem)] max-w-full bg-black">
              {videoSource(url, name)}
            </video>
          ) : (
            <img src={url} alt={name} className="max-h-[calc(100vh-7rem)] max-w-full object-contain" />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
