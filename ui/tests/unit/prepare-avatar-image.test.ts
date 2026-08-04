import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_AGENT_AVATAR_BYTES, prepareAvatarImage } from '@src/lib/prepare-avatar-image';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function pngWithDimensions(width: number, height: number): Uint8Array {
  const bytes = Uint8Array.from(PNG_1X1);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function readFile(file: File): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read prepared avatar'));
    reader.onload = () => resolve(Buffer.from(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(file);
  });
}

function jpegWithDimensions(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(21);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  return bytes;
}

function webpWithDimensions(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WEBP'), 8);
  bytes.set(new TextEncoder().encode('VP8X'), 12);
  const writeU24LE = (offset: number, value: number) => {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >> 8) & 0xff;
    bytes[offset + 2] = (value >> 16) & 0xff;
  };
  writeU24LE(24, width - 1);
  writeU24LE(27, height - 1);
  return bytes;
}

function mockBrowserConversion(width: number, height: number): HTMLCanvasElement[] {
  const canvases: HTMLCanvasElement[] = [];
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
    if (tagName !== 'canvas') return createElement(tagName);
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (callback: BlobCallback) => {
        callback(new Blob([pngWithDimensions(canvas.width, canvas.height)], { type: 'image/png' }));
      },
    } as unknown as HTMLCanvasElement;
    canvases.push(canvas);
    return canvas;
  }) as typeof document.createElement);
  class MockImage {
    naturalWidth = width;
    naturalHeight = height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal('Image', MockImage);
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:avatar'),
    revokeObjectURL: vi.fn(),
  });
  return canvases;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('prepareAvatarImage', () => {
  it('keeps PNG bytes byte-identical and fixes only the upload filename', async () => {
    const source = new File([PNG_1X1], 'q-approved-source.png', { type: 'image/png' });

    const prepared = await prepareAvatarImage(source);
    const result = await readFile(prepared);

    expect(prepared.name).toBe('avatar.png');
    expect(prepared.type).toBe('image/png');
    expect(result).toEqual(PNG_1X1);
    expect(createHash('sha256').update(result).digest('hex')).toBe(createHash('sha256').update(PNG_1X1).digest('hex'));
  });

  it('rejects SVG and non-image bytes', async () => {
    await expect(prepareAvatarImage(new File(['<svg/>'], 'avatar.svg', { type: 'image/svg+xml' }))).rejects.toThrow(
      /PNG, JPEG, or WebP/,
    );
    await expect(prepareAvatarImage(new File(['not an image'], 'avatar.png', { type: 'image/png' }))).rejects.toThrow(
      /valid PNG, JPEG, or WebP/,
    );
    await expect(
      prepareAvatarImage(new File([PNG_1X1.subarray(0, 24)], 'truncated.png', { type: 'image/png' })),
    ).rejects.toThrow(/valid PNG, JPEG, or WebP/);
  });

  it('rejects files over 5 MiB and dimensions over 4096', async () => {
    await expect(
      prepareAvatarImage(new File([new Uint8Array(MAX_AGENT_AVATAR_BYTES + 1)], 'huge.png', { type: 'image/png' })),
    ).rejects.toThrow(/5 MiB/);
    await expect(
      prepareAvatarImage(new File([pngWithDimensions(4097, 1)], 'wide.png', { type: 'image/png' })),
    ).rejects.toThrow(/4096/);
    await expect(
      prepareAvatarImage(new File([pngWithDimensions(1, 4097)], 'tall.png', { type: 'image/png' })),
    ).rejects.toThrow(/4096/);
  });

  it.each([
    ['JPEG', 'image/jpeg', jpegWithDimensions(4, 2)],
    ['WebP', 'image/webp', webpWithDimensions(4, 2)],
  ])('converts %s without changing dimensions or aspect ratio', async (_label, type, source) => {
    const canvases = mockBrowserConversion(4, 2);

    const prepared = await prepareAvatarImage(new File([source], 'source', { type }));
    const result = await readFile(prepared);
    const view = new DataView(result.buffer, result.byteOffset, result.byteLength);

    expect(canvases).toHaveLength(1);
    expect([canvases[0].width, canvases[0].height]).toEqual([4, 2]);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([4, 2]);
    expect(prepared.name).toBe('avatar.png');
    expect(prepared.type).toBe('image/png');
  });
});
