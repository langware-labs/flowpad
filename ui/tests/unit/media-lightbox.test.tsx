import '@testing-library/jest-dom/vitest';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MediaLightbox } from '@src/components/ui/media-lightbox';

vi.mock('@src/notifications', () => ({ notify: { error: vi.fn() } }));

describe('MediaLightbox', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('closes from the Close button and from a click outside the frame, but not inside it', () => {
    const onClose = vi.fn();
    render(<MediaLightbox url="/files/a.png" name="a.png" onClose={onClose} />);
    fireEvent.click(screen.getByTestId('media-lightbox-frame'));
    fireEvent.click(screen.getByRole('img'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('media-lightbox-close'));
    fireEvent.click(screen.getByTestId('media-lightbox'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('copies the image to the clipboard as PNG', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { write } });
    vi.stubGlobal(
      'ClipboardItem',
      class {
        items: Record<string, unknown>;
        constructor(items: Record<string, unknown>) {
          this.items = items;
        }
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ blob: () => Promise.resolve(new Blob(['x'], { type: 'image/png' })) }),
    );
    render(<MediaLightbox url="/files/a.png" name="a.png" onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('media-lightbox-copy'));
    await act(() => Promise.resolve());
    expect(write).toHaveBeenCalledTimes(1);
    const [[[item]]] = write.mock.calls;
    await expect(item.items['image/png']).resolves.toBeInstanceOf(Blob);
    expect(screen.getByTestId('media-lightbox-copy')).toHaveTextContent('Copied');
  });

  it('offers no copy for a video', () => {
    render(<MediaLightbox url="/files/a.mp4" name="a.mp4" onClose={vi.fn()} />);
    expect(screen.queryByTestId('media-lightbox-copy')).toBeNull();
    expect(screen.getByTestId('media-lightbox-close')).toBeInTheDocument();
  });
});
