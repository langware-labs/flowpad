import { detectLanguage, FSRef } from '@sdk';
import { parseFrontmatterDoc } from '@sdk/fs/frontmatter-parse';
import { isFolderShape, type TypeShape } from '@sdk/FlowSync/schema';
import { MarkdownView } from '@src/components/markdown-view';
import { useFSRefContent } from '@src/hooks/use-fs-ref-content';
import { ReportAssetShell } from './ReportAssetShell';

/** The registry supplies the inner document; the clicked occurrence supplies
 * its folder. A same-ID Entity's primary file never participates. */
export function assetOccurrenceMainRef(ref: FSRef, shape?: TypeShape | null): FSRef {
  return isFolderShape(shape) && shape.main && !ref.path.endsWith(`/${shape.main}`)
    ? ref.child(shape.main)
    : ref;
}

/** A file-only projection for custom domain forms that cannot yet represent
 * read-only occurrences. No domain entity, save handler or launch action. */
export function ReadOnlyAssetPreview({ fsRef }: { fsRef: FSRef }) {
  const { content, isLoading, loadError, isMissing } = useFSRefContent(fsRef, { autoSave: false });
  return (
    <ReportAssetShell fsRef={fsRef} testId="readonly-asset-preview" loading={isLoading}
      error={loadError?.message ?? (isMissing ? fsRef.path : null)}>
      {!isLoading && !loadError && !isMissing && (
        detectLanguage(fsRef.path) === 'markdown'
          ? <MarkdownView value={parseFrontmatterDoc(content).body} />
          : <pre className="whitespace-pre-wrap break-words font-mono text-xs" data-testid="readonly-asset-code">{content}</pre>
      )}
    </ReportAssetShell>
  );
}
