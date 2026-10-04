/**
 * Batch entry point used by every image-capture surface: run incoming files
 * through the annotator popup before they're attached/uploaded.
 *
 *   const { files, caption } = await annotateImageFiles(files, { initialCaption });
 *
 * Rasterizable images open the popup (sequentially, one at a time); everything
 * else — non-images and SVG (vector, can't faithfully rasterize) — passes
 * straight through untouched. Saving returns the annotated PNG; cancelling
 * aborts that image — it is DROPPED from the result, not attached, and so is
 * its caption. The returned list may therefore be shorter than (or empty
 * relative to) the input.
 *
 * `caption` is what the user typed under the image(s), non-empty captions joined
 * by newlines; '' when nothing was typed. `initialCaption` prefills only the
 * first image's caption, so text pasted alongside lands once.
 */
import type { ReactNode } from 'react';
import { isRasterizableImage } from '@src/utils/clipboard-image';
import { annotateImage } from './image-annotator-store';

export interface AnnotatedFiles {
  files: File[];
  caption: string;
}

export async function annotateImageFiles(
  files: File[],
  { initialCaption, submitLabel }: { initialCaption?: string; submitLabel?: ReactNode } = {},
): Promise<AnnotatedFiles> {
  const out: File[] = [];
  const captions: string[] = [];
  let prefill = initialCaption;
  for (const file of files) {
    if (!isRasterizableImage(file)) {
      out.push(file);
      continue;
    }
    const result = await annotateImage(file, { initialCaption: prefill, submitLabel });
    prefill = undefined;
    if (!result) continue; // cancelled => drop it
    out.push(result.file);
    if (result.caption) captions.push(result.caption);
  }
  return { files: out, caption: captions.join('\n') };
}
