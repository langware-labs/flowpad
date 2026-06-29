/**
 * Batch entry point used by every image-capture surface: run incoming files
 * through the annotator popup before they're attached/uploaded.
 *
 *   files = await annotateImageFiles(files);
 *
 * Rasterizable images open the popup (sequentially, one at a time); everything
 * else — non-images and SVG (vector, can't faithfully rasterize) — passes
 * straight through untouched. Saving returns the annotated PNG; cancelling
 * aborts that image — it is DROPPED from the result, not attached. The returned
 * list may therefore be shorter than (or empty relative to) the input.
 */
import { isRasterizableImage } from '@src/utils/clipboard-image';
import { annotateImage } from './image-annotator-store';

export async function annotateImageFiles(files: File[]): Promise<File[]> {
  const out: File[] = [];
  for (const file of files) {
    if (!isRasterizableImage(file)) {
      out.push(file);
      continue;
    }
    const annotated = await annotateImage(file);
    if (annotated) out.push(annotated); // null => cancelled => drop it
  }
  return out;
}
