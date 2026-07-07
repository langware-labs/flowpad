/**
 * The ONE markdown-document path predicate. Every surface that decides
 * "document viewer vs code editor" for a file path must use this — the
 * display-annotation classifier, `DockPointer.forLocalFile`, and (through it)
 * `navigation.openFile` — so the extension set can never drift between them.
 */
export const MARKDOWN_PATH_RE = /\.(?:md|markdown|mdx|mdo|md\.out)$/i;

export function isMarkdownDocumentPath(path?: string | null): boolean {
  return Boolean(path && MARKDOWN_PATH_RE.test(path));
}
