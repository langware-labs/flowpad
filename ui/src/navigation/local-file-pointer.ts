import { isMarkdownDocumentPath } from '@src/lib/markdown-path';
import { DockPointer } from './DockPointer';

/**
 * THE pointer-level chokepoint for every generic "open this file" surface —
 * file browsers, chat attachments, task artifacts, `navigation.openFile`.
 * Markdown documents route to the assets markdown editor (share / chat /
 * rendered view); everything else to the code editor. Callers that explicitly
 * want the code editor (an "Open in Editor" affordance, code hook sources)
 * use `DockPointer.forFile` directly.
 */
export function dockPointerForFile(
  path: string,
  options?: { line?: number; column?: number },
): DockPointer {
  if (isMarkdownDocumentPath(path)) {
    return DockPointer.forAssetEditor('markdown', path);
  }
  return DockPointer.forFile(path, options);
}
