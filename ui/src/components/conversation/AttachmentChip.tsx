import { useEffect, useRef, useState } from 'react';
import {
  Download,
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Link as LinkIcon,
  Loader2,
  MoreVertical,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@src/lib/utils';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'webm', 'ogv', 'ogg']);
const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
};

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function isImage(name: string): boolean {
  return IMAGE_EXTS.has(extOf(name));
}

function isVideo(name: string): boolean {
  return VIDEO_EXTS.has(extOf(name));
}

interface FileMeta {
  Icon: LucideIcon;
  bg: string;
  label: string;
}

function fileMeta(name: string): FileMeta {
  const ext = extOf(name);
  const upper = ext ? ext.toUpperCase() : 'FILE';
  if (ext === 'pdf') return { Icon: FileText, bg: 'bg-red-500', label: 'PDF' };
  if (['doc', 'docx', 'rtf', 'odt'].includes(ext)) return { Icon: FileText, bg: 'bg-blue-500', label: upper };
  if (['xls', 'xlsx', 'csv', 'ods', 'tsv'].includes(ext))
    return { Icon: FileSpreadsheet, bg: 'bg-emerald-600', label: upper };
  if (['ppt', 'pptx', 'odp', 'key'].includes(ext)) return { Icon: FileText, bg: 'bg-orange-500', label: upper };
  if (['zip', 'tar', 'gz', '7z', 'rar', 'bz2', 'xz'].includes(ext))
    return { Icon: FileArchive, bg: 'bg-yellow-600', label: upper };
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'].includes(ext))
    return { Icon: FileAudio, bg: 'bg-indigo-500', label: upper };
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return { Icon: FileVideo, bg: 'bg-pink-500', label: upper };
  if (
    [
      'js',
      'jsx',
      'ts',
      'tsx',
      'json',
      'html',
      'htm',
      'css',
      'scss',
      'sass',
      'py',
      'java',
      'c',
      'h',
      'cpp',
      'hpp',
      'rb',
      'go',
      'rs',
      'sh',
      'bash',
      'zsh',
      'yaml',
      'yml',
      'toml',
      'xml',
      'sql',
      'php',
      'kt',
      'swift',
    ].includes(ext)
  ) {
    return { Icon: FileCode, bg: 'bg-purple-500', label: upper };
  }
  if (['md', 'mdx', 'txt', 'log', 'rst'].includes(ext)) return { Icon: FileText, bg: 'bg-slate-500', label: upper };
  return { Icon: File, bg: 'bg-slate-500', label: upper };
}

function absoluteUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return window.location.origin + (url.startsWith('/') ? url : `/${url}`);
}

/** Body-bundle lifecycle as the chip sees it:
 *  - Uploading    : sender is still staging the body — bytes not on the hub yet.
 *  - Ready        : body is on the hub but not on this machine — click to pull.
 *  - Downloaded   : bytes are local — open/save normally (also: text-only and
 *                   purely-local conversations, which never round-trip a body).
 *  - Unavailable  : there is no body to fetch (``body_status='na'`` and the
 *                   bytes are not local) — a dangling pointer. Inert: we render
 *                   a muted row and NEVER a live URL, so nothing 404s. */
export enum AttachmentChipState {
  Uploading = 'uploading',
  Ready = 'ready',
  Downloaded = 'downloaded',
  Unavailable = 'unavailable',
}

interface AttachmentChipProps {
  url: string;
  filename: string;
  /** Defaults to Downloaded — the file is local and openable. */
  state?: AttachmentChipState;
  /** Invoked when a READY chip is clicked — triggers the body-bundle pull. */
  onDownload?: () => void;
  /** True while that body-bundle pull is in flight. */
  downloading?: boolean;
}

export function AttachmentChip({
  url,
  filename,
  state = AttachmentChipState.Downloaded,
  onDownload,
  downloading = false,
}: AttachmentChipProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [menuOpen]);

  // UPLOADING / READY / UNAVAILABLE: the bytes aren't on this machine, so there
  // is no live URL to link or inline-render. Render a status row instead —
  // greyed + inert for UPLOADING, dashed + clickable (→ download) for READY,
  // muted + inert for UNAVAILABLE (a dangling pointer with no body to fetch).
  // Placed after every hook so hook order stays stable across renders.
  if (state !== AttachmentChipState.Downloaded) {
    const { Icon, bg, label } = fileMeta(filename);
    const isUploading = state === AttachmentChipState.Uploading;
    const isUnavailable = state === AttachmentChipState.Unavailable;
    const inert = isUploading || isUnavailable;
    const clickable = state === AttachmentChipState.Ready && !downloading && !!onDownload;
    const sub = isUploading
      ? 'Uploading…'
      : isUnavailable
        ? 'Unavailable'
        : downloading
          ? 'Downloading…'
          : `${label} · Download`;
    const title = isUploading
      ? 'File not uploaded yet'
      : isUnavailable
        ? 'Attachment unavailable — no body was uploaded'
        : downloading
          ? 'Downloading…'
          : 'Click to download';
    return (
      <div className="max-w-[360px]">
        <button
          type="button"
          disabled={!clickable}
          onClick={clickable ? () => onDownload?.() : undefined}
          title={title}
          className={cn(
            'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
            inert
              ? 'cursor-not-allowed border-border bg-background opacity-50'
              : clickable
                ? 'cursor-pointer border-dashed border-primary/60 bg-background hover:bg-muted/40'
                : 'cursor-default border-dashed border-primary/60 bg-background',
          )}
        >
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded text-white',
              inert ? 'bg-slate-400' : bg,
            )}
          >
            {downloading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Icon className="h-5 w-5" />}
          </div>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-foreground">{filename}</span>
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{sub}</span>
          </div>
        </button>
      </div>
    );
  }

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(absoluteUrl(url));
    } catch {
      // ignore — clipboard may be blocked outside secure context
    }
    setMenuOpen(false);
  };

  const overlay = (
    <div className="absolute right-1 top-1 z-10">
      <div className="flex items-center gap-0.5 rounded-md border border-border bg-background/95 p-0.5 shadow-sm backdrop-blur-sm">
        <a
          href={url}
          download={filename}
          title="Download"
          onClick={(e) => e.stopPropagation()}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Download className="h-3.5 w-3.5" />
        </a>
        <button
          type="button"
          title="More actions"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
      </div>
      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 min-w-[160px] rounded-md border border-border bg-popover p-1 text-xs shadow-md"
          onClick={(e) => e.stopPropagation()}
        >
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            onClick={() => setMenuOpen(false)}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-foreground transition-colors hover:bg-muted"
          >
            <ExternalLink className="h-3 w-3 text-muted-foreground" />
            Open in new tab
          </a>
          <button
            type="button"
            onClick={() => void handleCopyLink()}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-foreground transition-colors hover:bg-muted"
          >
            <LinkIcon className="h-3 w-3 text-muted-foreground" />
            Copy link
          </button>
          <a
            href={url}
            download={filename}
            onClick={() => setMenuOpen(false)}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-foreground transition-colors hover:bg-muted"
          >
            <Download className="h-3 w-3 text-muted-foreground" />
            Download
          </a>
        </div>
      )}
    </div>
  );

  if (isImage(filename) && !imgFailed) {
    return (
      <div ref={containerRef} className="group relative inline-block">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="block max-w-[360px] overflow-hidden rounded-lg border border-border bg-muted/40"
          title={filename}
        >
          <img
            src={url}
            alt={filename}
            onError={() => setImgFailed(true)}
            className="block max-h-[280px] max-w-full object-contain"
          />
        </a>
        {overlay}
      </div>
    );
  }

  if (isVideo(filename) && !videoFailed) {
    const mime = VIDEO_MIME[extOf(filename)];
    return (
      <div ref={containerRef} className="group relative inline-block">
        <div className="block max-w-[360px] overflow-hidden rounded-lg border border-border bg-black" title={filename}>
          <video
            controls
            preload="metadata"
            playsInline
            onError={() => setVideoFailed(true)}
            className="block max-h-[280px] max-w-full bg-black"
          >
            {mime ? <source src={url} type={mime} /> : <source src={url} />}
          </video>
        </div>
        {overlay}
      </div>
    );
  }

  const { Icon, bg, label } = fileMeta(filename);

  return (
    <div ref={containerRef} className="group relative max-w-[360px]">
      <a
        href={url}
        download={filename}
        target="_blank"
        rel="noreferrer"
        title={filename}
        className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 transition-colors hover:bg-muted/40"
      >
        <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded text-white', bg)}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex min-w-0 flex-col pr-14">
          <span className="truncate text-sm font-medium text-foreground">{filename}</span>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
        </div>
      </a>
      {overlay}
    </div>
  );
}
