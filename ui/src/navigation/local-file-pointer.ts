import { isMarkdownDocumentPath } from '@src/lib/markdown-path';
import { AssetDocPointer } from './AssetDocPointer';
import { AssetEditor, editorForPath } from './asset-doc-types';
import { DockPointer } from './DockPointer';

/**
 * THE pointer-level chokepoint for every generic "open this file" surface —
 * file browsers, chat attachments, task artifacts, `navigation.openFile`.
 * Routing is the shared `editorForPath` extension rule: markdown → markdown
 * editor, html → sandboxed preview, images/video/audio → media viewer,
 * everything else → the code editor. Callers that explicitly want the code
 * editor (an "Open in Editor" affordance, code hook sources) use
 * `DockPointer.forFile` directly.
 *
 * NOTE: markdown keeps the wider `isMarkdownDocumentPath` predicate (mdx,
 * md.out, …) — the SDK map only knows md/markdown. Built via
 * `AssetDocPointer.forVfs`, NOT `DockPointer.forAssetEditor` (that takes a
 * record type and falls back to MARKDOWN for unknown types).
 */
export function dockPointerForFile(
  path: string,
  options?: { line?: number; column?: number },
): DockPointer {
  const editor = isMarkdownDocumentPath(path) ? AssetEditor.MARKDOWN : editorForPath(path);
  if (editor !== AssetEditor.CODE) {
    // Carry the line across too. The asset editors name it `initialLine`
    // (`MilkdownEditor`'s "place the caret here on mount" prop) rather than the
    // code editor's `line`, so translate instead of dropping it — without this
    // an "open at line" into a .md target silently loses the line.
    const assetOptions = options?.line ? { initialLine: String(options.line) } : undefined;
    return AssetDocPointer.forVfs(editor, path, undefined, assetOptions).toDockPointer();
  }
  return DockPointer.forFile(path, options);
}
