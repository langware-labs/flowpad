import { describe, expect, it } from 'vitest';
import {
  clipboardImageFilename,
  imageFilesFromClipboardItems,
  imageFilesFromClipboardData,
  isImageFile,
} from '@src/utils/clipboard-image';

function clipboardData({
  items = [],
  files = [],
}: {
  items?: Array<{ kind: string; type: string; getAsFile: () => File | null }>;
  files?: File[];
}): DataTransfer {
  return {
    items,
    files,
  } as unknown as DataTransfer;
}

describe('clipboard image helpers', () => {
  const now = new Date(2026, 5, 14, 9, 8, 7, 6);

  it('renames generic clipboard images to stable pasted-image filenames', () => {
    const file = new File(['png-bytes'], 'image.png', { type: 'image/png', lastModified: 1 });
    const out = imageFilesFromClipboardData(
      clipboardData({
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      }),
      now,
    );

    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('pasted-image-20260614-090807-006.png');
    expect(out[0].type).toBe('image/png');
    expect(out[0].lastModified).toBe(now.getTime());
  });

  it('keeps real image filenames when the clipboard carries one', () => {
    const file = new File(['jpg-bytes'], 'diagram.jpg', { type: 'image/jpeg' });

    expect(clipboardImageFilename(file, 0, now)).toBe('diagram.jpg');
    expect(imageFilesFromClipboardData(clipboardData({ files: [file] }), now)[0]).toBe(file);
  });

  it('adds suffixes for multiple generic pasted images', () => {
    const first = new File(['one'], 'image.png', { type: 'image/png' });
    const second = new File(['two'], 'image.png', { type: 'image/png' });
    const out = imageFilesFromClipboardData(
      clipboardData({
        items: [
          { kind: 'file', type: 'image/png', getAsFile: () => first },
          { kind: 'file', type: 'image/png', getAsFile: () => second },
        ],
      }),
      now,
    );

    expect(out.map((f) => f.name)).toEqual([
      'pasted-image-20260614-090807-006.png',
      'pasted-image-20260614-090807-006-2.png',
    ]);
  });

  it('falls back to clipboard files and filters non-images', () => {
    const image = new File(['webp'], 'image', { type: 'image/webp' });
    const text = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const out = imageFilesFromClipboardData(clipboardData({ files: [image, text] }), now);

    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('pasted-image-20260614-090807-006.webp');
    expect(isImageFile(text)).toBe(false);
  });

  it('extracts image files from async clipboard items with a reusable prefix', async () => {
    const blob = new Blob(['png'], { type: 'image/png' });
    const out = await imageFilesFromClipboardItems(
      [
        {
          types: ['text/plain', 'image/png'],
          getType: (type: string) => {
            if (type !== 'image/png') throw new Error(`unexpected type ${type}`);
            return Promise.resolve(blob);
          },
        } as unknown as ClipboardItem,
      ],
      now,
      { prefix: 'screenshot' },
    );

    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('screenshot-20260614-090807-006.png');
    expect(out[0].type).toBe('image/png');
  });
});
