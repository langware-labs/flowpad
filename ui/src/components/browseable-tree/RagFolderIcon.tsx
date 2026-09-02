/**
 * A folder glyph that wears a brain when that folder is a RAG index root.
 *
 * A COMPONENT, not a function returning an element, so the roots are read when the row
 * renders rather than when it was built. Tree rows are cached by node id and the roots arrive
 * from a query moments after the tree first expands; a build-time answer would be frozen wrong
 * for every row listed before that.
 */
import { Brain } from 'lucide-react';
import { IconWithBadge, type IconComp } from '@src/components/graph-view/icons/IconWithBadge';
import { isRagRoot, useRagRoots } from '@src/hooks/use-rag-roots';

interface RagFolderIconProps {
  /** The row's own glyph — a plain folder, or something else the row already earned. */
  Base: IconComp;
  /** Canonical machine path of this folder (`VFSPath.machinePath`), or null for a row with none. */
  path: string | null;
  /** Sizing only, e.g. `h-3.5 w-3.5`. Colour is this component's business. */
  size?: string;
}

export function RagFolderIcon({ Base, path, size = 'h-3.5 w-3.5' }: RagFolderIconProps) {
  const roots = useRagRoots();
  if (!isRagRoot(roots, path)) {
    return <Base className={`${size} flex-shrink-0 text-muted-foreground`} />;
  }
  return (
    <IconWithBadge
      Base={Base}
      Badge={Brain}
      className={`${size} flex-shrink-0`}
      baseClassName="text-muted-foreground"
      // Bigger and heavier than the composer's default corner chip: at a 14px row glyph the
      // default 55% badge is under 8px, where a brain is an unreadable smudge. Sitting a little
      // outside the base and dropping the inner padding buys back the pixels that make it
      // legible as a brain rather than a dot.
      badgeClassName="h-[72%] w-[72%] -bottom-1 -right-1 p-0 text-primary [stroke-width:2.25]"
      data-testid="rag-root-badge"
      aria-label="Indexed for search"
    />
  );
}
