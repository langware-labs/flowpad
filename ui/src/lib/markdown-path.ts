import { documentFileExtensions, markdownExtensions, RecordType } from '@sdk';

/**
 * The ONE markdown-document path predicate. Every surface that decides
 * "document viewer vs code editor" for a file path must use this — the
 * display-annotation classifier, `dockPointerForFile`, and (through it)
 * `navigation.openFile` — so the extension set can never drift between them.
 *
 * The set is the registry's `markdown` shape (`shape.ext` + `also`, from the
 * bootstrap `types`) via the SDK's `markdownExtensions()`, widened by the
 * display-only spellings below that no record type claims (mdx, md.out, …).
 * The static md/markdown pair is only the SDK's fallback for an unbound
 * registry (hub / unit tests).
 */
const EXTRA_MARKDOWN_EXTENSIONS = ['mdx', 'mdo', 'md.out'];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Built per call: the registry binds after module init. */
export function markdownPathRe(): RegExp {
  const exts = [...new Set([...markdownExtensions(), ...EXTRA_MARKDOWN_EXTENSIONS])];
  return new RegExp(`\\.(?:${exts.map(escapeRe).join('|')})$`, 'i');
}

/** @deprecated the set is registry-derived; use `isMarkdownDocumentPath`. Kept
 *  as the unbound-registry regex for callers that still import it. */
export const MARKDOWN_PATH_RE = /\.(?:md|markdown|mdx|mdo|md\.out)$/i;

export function isMarkdownDocumentPath(path?: string | null): boolean {
  return Boolean(path && markdownPathRe().test(path));
}

/** A read-only document file (`.docx` / `.txt`) the Documents tree lists beside
 *  markdown — the `document_file` type, opened in its read-only preview. */
export function isDocumentFilePath(path?: string | null): boolean {
  const lower = path?.toLowerCase();
  return Boolean(lower && documentFileExtensions().some((ext) => lower.endsWith(`.${ext.toLowerCase()}`)));
}

/** The Documents tree's type for a file: `document_file` or markdown. */
export function documentsTreeType(path: string): string {
  return isDocumentFilePath(path) ? RecordType.DOCUMENT_FILE : RecordType.MARKDOWN;
}
