import { AGENT_AVATAR_FILE } from '@sdk/entities/agent-avatar';

export const MAX_AGENT_AVATAR_BYTES = 5 * 1024 * 1024;
export const MAX_AGENT_AVATAR_DIMENSION = 4096;

type RasterKind = 'image/png' | 'image/jpeg' | 'image/webp';

interface RasterInfo {
  kind: RasterKind;
  width: number;
  height: number;
}

function readU24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function pngInfo(bytes: Uint8Array): RasterInfo | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = signature.length;
  let width = 0;
  let height = 0;
  let sawImageData = false;
  let sawEnd = false;

  while (offset + 12 <= bytes.length) {
    const dataLength = view.getUint32(offset);
    const chunkEnd = offset + 12 + dataLength;
    if (chunkEnd > bytes.length) return null;
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (offset === signature.length) {
      if (type !== 'IHDR' || dataLength !== 13) return null;
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
    } else if (type === 'IHDR') {
      return null;
    }
    if (type === 'IDAT') sawImageData = true;
    if (type === 'IEND') {
      if (dataLength !== 0 || chunkEnd !== bytes.length) return null;
      sawEnd = true;
      break;
    }
    offset = chunkEnd;
  }

  return width && height && sawImageData && sawEnd ? { kind: 'image/png', width, height } : null;
}

function jpegInfo(bytes: Uint8Array): RasterInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;
    const segmentLength = view.getUint16(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (startOfFrame.has(marker) && segmentLength >= 7) {
      return {
        kind: 'image/jpeg',
        height: view.getUint16(offset + 3),
        width: view.getUint16(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function webpInfo(bytes: Uint8Array): RasterInfo | null {
  const ascii = (offset: number, value: string) =>
    [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  if (bytes.length < 30 || !ascii(0, 'RIFF') || !ascii(8, 'WEBP')) return null;
  if (ascii(12, 'VP8X')) {
    return {
      kind: 'image/webp',
      width: readU24LE(bytes, 24) + 1,
      height: readU24LE(bytes, 27) + 1,
    };
  }
  if (ascii(12, 'VP8L') && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b0 = bytes[21];
    const b1 = bytes[22];
    const b2 = bytes[23];
    const b3 = bytes[24];
    return {
      kind: 'image/webp',
      width: 1 + (b0 | ((b1 & 0x3f) << 8)),
      height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
    };
  }
  if (ascii(12, 'VP8 ') && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      kind: 'image/webp',
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  return null;
}

function inspectRaster(bytes: Uint8Array): RasterInfo | null {
  return pngInfo(bytes) ?? jpegInfo(bytes) ?? webpInfo(bytes);
}

function normalizedDeclaredType(type: string): RasterKind | '' | null {
  if (!type) return '';
  if (type === 'image/jpg') return 'image/jpeg';
  if (type === 'image/png' || type === 'image/jpeg' || type === 'image/webp') return type;
  return null;
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the selected image'));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });
}

async function withRasterImage<T>(
  file: File,
  expected: RasterInfo,
  consumeImage: (image: HTMLImageElement) => T | Promise<T>,
): Promise<T> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Could not decode the selected image'));
      element.src = url;
    });
    if (image.naturalWidth !== expected.width || image.naturalHeight !== expected.height) {
      throw new Error('Decoded image dimensions do not match its encoded dimensions');
    }
    return await consumeImage(image);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function assertPngDecodes(file: File, expected: RasterInfo): Promise<void> {
  if (typeof Image === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return;
  }
  await withRasterImage(file, expected, () => undefined);
}

async function convertToPng(file: File, expected: RasterInfo): Promise<File> {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('This browser cannot safely convert the selected image to PNG');
  }
  return withRasterImage(file, expected, async (image) => {
    const canvas = document.createElement('canvas');
    canvas.width = expected.width;
    canvas.height = expected.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot safely convert the selected image to PNG');
    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('Could not convert the selected image'))),
        'image/png',
      );
    });
    if (blob.size > MAX_AGENT_AVATAR_BYTES) {
      throw new Error('Converted avatar must be 5 MiB or smaller');
    }
    return new File([blob], AGENT_AVATAR_FILE, { type: 'image/png', lastModified: file.lastModified });
  });
}

/** Validate an avatar and normalize its upload name without rewriting PNG bytes. */
export async function prepareAvatarImage(file: File): Promise<File> {
  if (file.size > MAX_AGENT_AVATAR_BYTES) throw new Error('Avatar must be 5 MiB or smaller');
  const declaredType = normalizedDeclaredType(file.type);
  if (declaredType === null) throw new Error('Avatar must be a PNG, JPEG, or WebP image');

  const bytes = await readBlobBytes(file);
  const info = inspectRaster(bytes);
  if (!info || (declaredType && declaredType !== info.kind)) {
    throw new Error('Avatar must be a valid PNG, JPEG, or WebP image');
  }
  if (
    !info.width ||
    !info.height ||
    info.width > MAX_AGENT_AVATAR_DIMENSION ||
    info.height > MAX_AGENT_AVATAR_DIMENSION
  ) {
    throw new Error('Avatar dimensions must not exceed 4096 × 4096');
  }
  if (info.kind === 'image/png') {
    await assertPngDecodes(file, info);
    return new File([file], AGENT_AVATAR_FILE, { type: 'image/png', lastModified: file.lastModified });
  }
  return convertToPng(file, info);
}
