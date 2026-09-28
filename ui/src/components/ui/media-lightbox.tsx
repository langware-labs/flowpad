import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { isImagePath } from '@sdk';

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

interface MediaLightboxProps {
  url: string;
  /** File name — picks image vs video and labels the dialog. */
  name: string;
  onClose: () => void;
}

/**
 * Fullscreen in-app preview for an image or video. Backdrop click + Esc close;
 * clicking the media itself does not. Portalled to `body` so a host with a
 * transform or overflow clip (a terminal pane, a chat bubble) can't trap it.
 */
export function MediaLightbox({ url, name, onClose }: MediaLightboxProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      data-testid="media-lightbox"
      onClick={onClose}
      className="fixed inset-0 z-[100] flex cursor-zoom-out items-center justify-center bg-black/80 p-6"
    >
      {isVideoPath(name) ? (
        <video
          controls
          autoPlay
          playsInline
          onClick={(e) => e.stopPropagation()}
          className="max-h-full max-w-full cursor-default rounded-lg bg-black shadow-2xl"
        >
          {videoSource(url, name)}
        </video>
      ) : (
        <img
          src={url}
          alt={name}
          onClick={(e) => e.stopPropagation()}
          className="max-h-full max-w-full cursor-default rounded-lg object-contain shadow-2xl"
        />
      )}
    </div>,
    document.body,
  );
}
