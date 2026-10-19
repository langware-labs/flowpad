import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  annotateImage,
  ImageAnnotatorRoot,
  type AnnotationResult,
} from '@src/components/image-annotator/image-annotator-store';

// jsdom has no canvas and decodes no images: a context that accepts any call, a toBlob that
// yields a PNG, and an Image that "loads" on the next tick stand in for the browser.
const fakeCtx = new Proxy({}, { get: () => vi.fn(() => ({ width: 10 })) });
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => fakeCtx) as never;
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
    cb(new Blob(['png'], { type: 'image/png' }));
  };
  URL.createObjectURL = vi.fn(() => 'blob:fake');
  URL.revokeObjectURL = vi.fn();
  globalThis.Image = class {
    onload: (() => void) | null = null;
    naturalWidth = 400;
    naturalHeight = 200;
    set src(_: string) {
      setTimeout(() => this.onload?.());
    }
  } as never;
});
afterEach(cleanup);

const shot = () => new File(['png'], 'shot.png', { type: 'image/png' });
const caption = () => screen.getByTestId<HTMLTextAreaElement>('image-annotator-caption');
const canvas = () => document.querySelector('canvas') as HTMLCanvasElement;
const enter = (target: Element, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(target, { key: 'Enter', bubbles: true, ...init });

/** Open the annotator the way a paste does, wait for the image to load. Boxed: an async
 *  function returning the bare promise would flatten it and wait for the dialog to close. */
async function open(initialCaption?: string): Promise<{ result: Promise<AnnotationResult | null> }> {
  render(<ImageAnnotatorRoot />);
  let result!: Promise<AnnotationResult | null>;
  act(() => {
    result = annotateImage(shot(), { initialCaption });
  });
  await screen.findByTestId('image-annotator-caption');
  await act(() => new Promise((r) => setTimeout(r, 0)));
  return { result };
}

describe('image annotator caption', () => {
  it('opens with the caption focused, so a paste can be followed straight by a note', async () => {
    await open();
    await waitFor(() => expect(document.activeElement).toBe(caption()));
  });

  it('Enter delivers the untouched image with the caption', async () => {
    const { result } = await open();
    fireEvent.change(caption(), { target: { value: '  the header overlaps  ' } });
    enter(caption());
    const saved = await result;
    expect(saved?.caption).toBe('the header overlaps');
    expect(saved?.file.name).toBe('shot.png'); // nothing drawn → the original, not a re-encode
  });

  it('Shift+Enter is a newline, not a send', async () => {
    const { result } = await open();
    const settled = vi.fn();
    void result.then(settled);
    enter(caption(), { shiftKey: true });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(settled).not.toHaveBeenCalled();
    expect(screen.queryByTestId('image-annotator-caption')).not.toBeNull();
  });

  it('text that came with the image prefills the caption', async () => {
    const { result } = await open('copied with the image');
    expect(caption().value).toBe('copied with the image');
    enter(caption());
    expect((await result)?.caption).toBe('copied with the image');
  });

  it('starting to draw takes focus off the caption; Enter still saves', async () => {
    const { result } = await open();
    fireEvent.change(caption(), { target: { value: 'note' } });
    await waitFor(() => expect(document.activeElement).toBe(caption()));
    fireEvent.pointerDown(canvas(), { clientX: 5, clientY: 5, pointerId: 1 });
    expect(document.activeElement).not.toBe(caption());
    fireEvent.pointerMove(canvas(), { clientX: 30, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(canvas(), { pointerId: 1 });
    enter(document.body);
    const saved = await result;
    expect(saved?.caption).toBe('note');
    expect(saved?.file.type).toBe('image/png');
  });

  it('a text label drawn on the image never becomes the caption', async () => {
    const { result } = await open();
    fireEvent.click(screen.getByTitle('Text'));
    fireEvent.pointerDown(canvas(), { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.click(canvas(), { clientX: 10, clientY: 10 });
    const label = await waitFor(() => {
      const el = document.querySelector('[contenteditable="true"]');
      expect(el).not.toBeNull();
      return el!;
    });
    label.textContent = 'label on the image';
    fireEvent.input(label);
    expect(caption().value).toBe('');
    enter(label); // commits the label
    enter(document.body); // saves
    expect((await result)?.caption).toBe('');
  });

  it('Esc with a typed caption asks before discarding it', async () => {
    await open();
    fireEvent.change(caption(), { target: { value: 'something' } });
    fireEvent.keyDown(caption(), { key: 'Escape', bubbles: true });
    expect(await screen.findByText('Discard changes?')).toBeTruthy();
  });
});
