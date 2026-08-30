import { t } from '@lingui/core/macro';
import { AgenticProcess, fsStore, TypeId } from '@sdk';
import { captureElementAsImageFile } from '@src/components/display-toolbar/capture-region';
import { annotateImage } from '@src/components/image-annotator/image-annotator-store';
import { resolveProcessInputDir } from '@src/utils/upload-to-input-dir';
import {
  buildDisplayAnnotationPrompt,
  displayAnnotationImageName,
  type DisplayAnnotationContext,
} from './display-annotation';

/**
 * Kept OUT of `display-annotation.ts` deliberately. That module is a leaf — pure
 * context builders and types — imported by navigation-adjacent code; giving it these
 * runtime dependencies (the SDK, the capture helper, the annotator store) closed an
 * import cycle that surfaced as a bare `ReferenceError: TypeId is not defined` at
 * app boot. Pipelines that touch stores belong beside the feature, not in the leaf.
 */
/**
 * Capture the display, let the user mark it up, and send it to the workspace chat.
 *
 * Lives here rather than in the toolbar component because none of it is rendering:
 * capture an element to a file, run the annotator, upload into the chat's input
 * directory, prompt the process. The component supplies only the element and the
 * process it belongs to.
 *
 * Resolves true when an annotation was submitted, false when the user cancelled.
 * Throws on a real failure so the caller can surface it.
 */
export async function submitDisplayAnnotation(
  process: AgenticProcess,
  target: HTMLElement,
  context: DisplayAnnotationContext,
): Promise<boolean> {
  const file = await captureElementAsImageFile(target, displayAnnotationImageName(context));
  return annotateImage(file, {
    submitLabel: t`Submit`,
    onSubmit: async (annotated) => {
      const dir = await resolveProcessInputDir(process.id);
      if (!dir) throw new Error('Could not resolve the chat input directory');
      const uploads = await fsStore
        .getState()
        .uploadFiles(new TypeId(dir.compute_node_id), dir.abs_path, [annotated]);
      await Promise.all(uploads.map((upload) => upload.waitForCompletion()));
      await process.prompt(
        buildDisplayAnnotationPrompt({
          fileName: annotated.name,
          filePath: `${dir.abs_path}/${annotated.name}`,
          context,
        }),
      );
    },
  });
}
