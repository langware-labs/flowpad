/**
 * WikiToolbar — wiki-linkage actions, rendered inline at the right end of
 * Milkdown's static toolbar (same `FormatButton` style as Bold/Italic/etc).
 * Currently a single button: "Add entity link" → opens the search modal.
 */

import type { Editor } from '@milkdown/core';
import { FormatButton } from '@src/components/milkdown-editor/MilkdownEditor';
import { Link2 } from 'lucide-react';
import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { WikiLinkInsertDialog } from './WikiLinkInsertDialog';

interface WikiToolbarProps {
  /** Imperative handle to the underlying Milkdown editor for cursor inserts. */
  editorRef: React.MutableRefObject<Editor | null>;
  /**
   * Source entity for this doc. When provided, an immediate reindex fires
   * after insert so getLinks() reflects the new edge. When null (e.g. system
   * docs that aren't indexed as entities), insert still works — the edge
   * lands later via sync_to_db once the doc is registered.
   */
  sourceTypeId: string | null;
}

export function WikiToolbar({ editorRef, sourceTypeId }: WikiToolbarProps) {
  const { t } = useLingui();
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <FormatButton
        title={t`Add entity link`}
        icon={<Link2 className="h-3.5 w-3.5" />}
        testId="wiki-toolbar-add-link"
        onMouseDown={(e) => {
          e.preventDefault();
          setDialogOpen(true);
        }}
      />
      <WikiLinkInsertDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editorRef={editorRef}
        sourceTypeId={sourceTypeId}
      />
    </>
  );
}
