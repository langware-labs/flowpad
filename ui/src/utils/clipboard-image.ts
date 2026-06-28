import { isImagePath } from '@sdk';

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
};

const GENERIC_CLIPBOARD_IMAGE_NAMES = new Set(['', 'image', 'image.png', 'image.jpg', 'image.jpeg', 'blob']);

export interface ClipboardImageFilenameOptions {
  prefix?: string;
}

function extensionFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function imageExtension(type: string, name: string): string {
  const fromType = IMAGE_MIME_EXTENSIONS[type.toLowerCase()];
  if (fromType) return fromType;
  return extensionFromName(name) || 'png';
}

function timestampForFilename(now: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    '-',
    pad(now.getMilliseconds(), 3),
  ].join('');
}

export function isImageFile(file: Pick<File, 'name' | 'type'>): boolean {
  return file.type.toLowerCase().startsWith('image/') || isImagePath(file.name);
}

// Raster image MIME types a <canvas> 2D context can decode and re-encode —
// every type in IMAGE_MIME_EXTENSIONS except SVG (vector; canvas tainting +
// fidelity loss). Single source of truth so a new format is added in one place.
const RASTERIZABLE_IMAGE_MIMES = new Set(
  Object.keys(IMAGE_MIME_EXTENSIONS).filter((mime) => mime !== 'image/svg+xml'),
);

/** True when the file is an image the canvas can rasterize (excludes SVG). */
export function isRasterizableImage(file: Pick<File, 'type'>): boolean {
  return RASTERIZABLE_IMAGE_MIMES.has(file.type.toLowerCase());
}

export function clipboardImageFilename(
  file: Pick<File, 'name' | 'type'>,
  index: number,
  now = new Date(),
  options: ClipboardImageFilenameOptions = {},
): string {
  const rawName = (file.name || '').trim();
  if (rawName && !GENERIC_CLIPBOARD_IMAGE_NAMES.has(rawName.toLowerCase())) return rawName;
  const ext = imageExtension(file.type, rawName);
  const suffix = index > 0 ? `-${index + 1}` : '';
  const prefix = options.prefix ?? 'pasted-image';
  return `${prefix}-${timestampForFilename(now)}${suffix}.${ext}`;
}

function normalizeClipboardImageFile(
  file: File,
  index: number,
  now: Date,
  options?: ClipboardImageFilenameOptions,
): File {
  const filename = clipboardImageFilename(file, index, now, options);
  if (file.name === filename) return file;
  return new File([file], filename, {
    type: file.type || 'image/png',
    lastModified: now.getTime(),
  });
}

export function imageFileFromClipboardBlob(
  blob: Blob,
  index: number,
  now = new Date(),
  options?: ClipboardImageFilenameOptions,
): File {
  const type = blob.type || 'image/png';
  const filename = clipboardImageFilename({ name: '', type }, index, now, options);
  return new File([blob], filename, { type, lastModified: now.getTime() });
}

/** True when a paste/drop's clipboard data carries at least one image item. */
export function clipboardDataHasImage(clipboardData: DataTransfer | null): boolean {
  return Array.from(clipboardData?.items ?? []).some((it) => it.type.toLowerCase().startsWith('image/'));
}

export function imageFilesFromClipboardData(
  clipboardData: DataTransfer | null,
  now = new Date(),
  options?: ClipboardImageFilenameOptions,
): File[] {
  if (!clipboardData) return [];

  const files: File[] = [];
  const items = Array.from(clipboardData.items ?? []);
  for (const item of items) {
    if (item.kind !== 'file' || !item.type.toLowerCase().startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }

  if (files.length === 0) {
    for (const file of Array.from(clipboardData.files ?? [])) {
      if (isImageFile(file)) files.push(file);
    }
  }

  return files.map((file, index) => normalizeClipboardImageFile(file, index, now, options));
}

export async function imageFilesFromClipboardItems(
  items: ClipboardItem[] | null | undefined,
  now = new Date(),
  options?: ClipboardImageFilenameOptions,
): Promise<File[]> {
  if (!items) return [];

  const files: File[] = [];
  for (const item of items) {
    const imageType = item.types.find((type) => type.toLowerCase().startsWith('image/'));
    if (!imageType) continue;
    const blob = await item.getType(imageType);
    files.push(imageFileFromClipboardBlob(blob, files.length, now, options));
  }
  return files;
}
