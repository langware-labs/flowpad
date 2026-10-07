/**
 * The toolbar glyph for "make this folder searchable", showing the current answer.
 *
 * A component rather than a static node for the reason `RagFolderIcon` gives: rows are built
 * once and cached, while the roots arrive from a query after the tree has expanded, so the
 * answer has to be read at render time.
 */
import { RagIndex } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { isRagRoot, useRagIndexingRoots, useRagRoots } from '@src/hooks/use-rag-roots';
import { cn } from '@src/lib/utils';

export function RagToggleGlyph({ path }: { path: string }) {
  const covered = isRagRoot(useRagRoots(), path);
  const indexing = isRagRoot(useRagIndexingRoots(), path);
  // Glyph from the type registry, never a literal — the same rule the rail item follows
  // (`collapsed-sidebar.tsx`). `RagIndex._icon` is the one place the RAG glyph is chosen.
  const Glyph = iconForType(RagIndex.type);
  return (
    <Glyph
      className={cn(covered && 'text-primary', indexing && 'animate-pulse')}
      data-rag-state={indexing ? 'indexing' : covered ? 'covered' : 'off'}
    />
  );
}
