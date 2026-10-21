import { useCallback, useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { Trans } from '@lingui/react/macro';
import type { DocumentFile, FSRef } from '@sdk';
import { AssetEditorHeader } from '../AssetEditorHeader';
import { entityReloadKey } from '@src/utils/entity-reload-key';
import { basename, dirname } from '@src/components/asset-manager/asset-row-helpers';

interface DocumentFileViewerProps {
  /** FSRef to the .docx / .txt file. */
  fsRef: FSRef;
  /** Resolved backing entity (from EntityResolutionGate). */
  documentFile: DocumentFile;
}

/** Read-only preview of a .docx (rendered to HTML by mammoth) or a .txt file.
 *  Re-reads when the entity's `updated_date` moves (the file changed on disk). */
export function DocumentFileViewer({ fsRef, documentFile }: DocumentFileViewerProps) {
  const path = fsRef.path;
  const isDocx = documentFile.format === 'docx';
  const reloadKey = entityReloadKey((documentFile as { updated_date?: unknown }).updated_date);
  // A .docx renders to sanitized HTML; a .txt is shown as its text.
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const load = async (): Promise<string> => {
      if (!isDocx) return fsRef.read();
      const [{ default: mammoth }, blob] = await Promise.all([
        import('mammoth'),
        fsRef.readBlob(),
      ]);
      const { value } = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
      return DOMPurify.sanitize(value);
    };
    load()
      .then((c) => !cancelled && setContent(c))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [fsRef, reloadKey, isDocx]);
  const onOpenExternal = useCallback(() => void fsRef.open(), [fsRef]);
  const onRevealInFinder = useCallback(() => void fsRef.open({ select: true }), [fsRef]);

  return (
    <div className="flex h-full w-full flex-col" data-testid="document-file-viewer">
      <AssetEditorHeader
        fileName={basename(path)}
        dirPath={dirname(path)}
        sourcePath={path}
        onOpenExternal={onOpenExternal}
        onRevealInFinder={onRevealInFinder}
        actions={
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            <Trans>Read-only</Trans>
          </span>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-6 text-sm text-destructive">
            <Trans>Could not open this document: {error}</Trans>
          </div>
        ) : content === null ? (
          <div className="p-6 text-sm text-muted-foreground">
            <Trans>Loading…</Trans>
          </div>
        ) : isDocx ? (
          <article
            className="prose prose-sm mx-auto max-w-3xl px-8 py-6 dark:prose-invert"
            dangerouslySetInnerHTML={{ __html: content }}
          />
        ) : (
          <pre className="mx-auto max-w-3xl whitespace-pre-wrap break-words px-8 py-6 font-sans text-sm">
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}
