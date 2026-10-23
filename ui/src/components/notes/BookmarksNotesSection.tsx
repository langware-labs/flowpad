import { useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { deleteNote, saveNote, useAllNotes } from '@src/hooks/use-entity-notes';
import { NoteCard, NoteRow } from './NoteViews';

/**
 * The Bookmarks menu's flat "Notes" section: every note, on any entity, newest
 * first. A picked note opens IN the section (the menu closes on pointer-leave,
 * so a popup beside it would vanish), with "Open" back to the view it was
 * written on.
 */
export function BookmarksNotesSection() {
  const notes = useAllNotes();
  const { navigation } = useDockNavigation();
  const [openId, setOpenId] = useState<string | null>(null);
  if (notes.length === 0) return null;
  const open = openId ? notes.find((n) => n.id === openId) : undefined;
  return (
    // A fixed width: the menu sizes to its content (max-content), and truncating
    // rows have no content width of their own.
    <div className="mt-1 w-[17rem] border-t border-border p-2 pt-2" data-testid="bookmarks-notes">
      <div className="px-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Trans>Notes · {notes.length}</Trans>
      </div>
      {open ? (
        <div className="overflow-hidden rounded-md border border-border">
          <NoteCard
            note={open}
            onSave={(patch) => saveNote(open, patch)}
            onDelete={async () => {
              await deleteNote(open);
              setOpenId(null);
            }}
            onClose={() => setOpenId(null)}
            onOpenEntity={() => {
              const raw = open.data?.dock as string | undefined;
              const dock = raw ? DockPointer.fromJSON(raw) : null;
              if (dock) navigation.openDock(dock);
            }}
          />
        </div>
      ) : (
        <div className="space-y-0.5">
          {notes.map((n) => (
            <NoteRow key={n.id} note={n} showEntity onPick={() => setOpenId(n.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
