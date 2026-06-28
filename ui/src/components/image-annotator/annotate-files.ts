/**
 * Batch entry point used by every image-capture surface: run incoming files
 * through the annotator popup before they're attached/uploaded.
 *
 *   files = await annotateImageFiles(files);
 *
 * Rasterizable images open the popup (sequentially, one at a time); everything
 * else — non-images and SVG (vector, can't faithfully rasterize) — passes
 * straight through untouched. If the user doesn't draw, the ORIGINAL File is
 * returned (no re-encode, bytes/extension preserved).
 */
import { isRasterizableImage } from '@src/utils/clipboard-image';
import { annotateImage } from './image-annotator-store';

export async function annotateImageFiles(files: File[]): Promise<File[]> {
  const out: File[] = [];
  for (const file of files) {
    out.push(isRasterizableImage(file) ? await annotateImage(file) : file);
  }
  return out;
}
