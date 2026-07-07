import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Inline-rename state machine shared by the desktop tiles (FavoriteTile,
 * FolderTile): editing/draft state, focus-and-select-all on entry, trim +
 * no-op guard on commit. Entered via double-click / F2 / context menu; the
 * caller renders `InlineRenameInput` while `editing`.
 */
export function useInlineRename(currentTitle: string, onCommit: (next: string) => void | Promise<void>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.setSelectionRange(0, inputRef.current.value.length);
    }
  }, [editing]);

  const startEditing = useCallback(() => {
    setDraft(currentTitle);
    setEditing(true);
  }, [currentTitle]);

  const cancelEditing = useCallback(() => setEditing(false), []);

  const commitRename = useCallback(async () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === currentTitle) return;
    await onCommit(next);
  }, [draft, currentTitle, onCommit]);

  return { editing, draft, setDraft, inputRef, startEditing, cancelEditing, commitRename };
}

export type InlineRename = ReturnType<typeof useInlineRename>;
