import { useEffect, useMemo, useState } from 'react';
import { FSRef } from '@sdk';
import DOMPurify from 'dompurify';
import { Trans } from '@lingui/react/macro';
import { useDownloadUrl } from '@src/hooks/use-download-url';

/** Read-only preview of any .docx by path (like PdfViewer): the raw bytes from
 *  the fs layer (FSRef.readBlob), rendered to sanitized HTML by mammoth. */
export function DocxViewer({ path }: { path: string }) {
  const { subPath, typeId, revision } = useDownloadUrl(path);
  const fsRef = useMemo(() => (typeId ? new FSRef(subPath, typeId) : null), [subPath, typeId]);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!fsRef) return;
    let cancelled = false;
    setError(null);
    (async () => {
      const [{ default: mammoth }, blob] = await Promise.all([import('mammoth'), fsRef.readBlob()]);
      const { value } = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
      return DOMPurify.sanitize(value);
    })()
      .then((h) => !cancelled && setHtml(h))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [fsRef, revision]);

  if (!fsRef || error) {
    return (
      <div className="p-6 text-sm text-destructive">
        <Trans>Could not open this document: {error ?? path}</Trans>
      </div>
    );
  }
  if (html === null) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        <Trans>Loading…</Trans>
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto bg-background" data-testid="docx-viewer">
      <article
        dir="auto"
        className="prose prose-sm mx-auto max-w-3xl px-8 py-6 dark:prose-invert"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

export default DocxViewer;
