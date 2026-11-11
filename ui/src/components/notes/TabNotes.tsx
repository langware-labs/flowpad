import { useMemo } from 'react';
import type { Annotation } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { Popover, PopoverAnchor, PopoverContent } from '@src/components/ui/popover';
import { addNote, deleteNote, saveNote, type NoteTarget } from '@src/hooks/use-entity-notes';
import { noteColor } from './note-palette';
import { NoteCard, NoteComposer, NotesList } from './NoteViews';
import { StickyNoteShape } from './StickyNoteShape';

/** What the strip's one notes popover is showing, and for which chip. */
export type TabNotesView =
  | { key: string; mode: 'compose' }
  | { key: string; mode: 'list' }
  | { key: string; mode: 'note'; noteId: string };

/** The chip drags on pointer-down and selects on click; a notes press must do neither. */
const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/** "Add a note" — beside the tab's bookmark star, shown with it after the hover delay. */
export function TabNoteButton({ onClick }: { onClick: () => void }) {
  const { t } = useLingui();
  return (
    <button
      type="button"
      title={t`Add a note`}
      aria-label={t`Add a note`}
      data-testid="tab-note-button"
      onPointerDown={stop}
      onClick={(e) => {
        stop(e);
        onClick();
      }}
      className="inline-flex shrink-0 items-center justify-center rounded opacity-80 hover:opacity-100"
    >
      <StickyNoteShape size={13} />
    </button>
  );
}

/** After the tab name: the newest note's colour and how many notes the entity has. */
export function TabNotesBadge({ notes, onClick }: { notes: readonly Annotation[]; onClick: () => void }) {
  const { t } = useLingui();
  if (notes.length === 0) return null;
  const label = t`${notes.length} notes`;
  const color = noteColor(notes[0].data?.color).token;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid="tab-notes-badge"
      data-note-color={color}
      onPointerDown={stop}
      onClick={(e) => {
        stop(e);
        onClick();
      }}
      className="relative inline-flex shrink-0 items-center"
    >
      <StickyNoteShape color={color} size={18} />
      <span className="absolute inset-0 flex items-center justify-center pb-[3px] pe-[3px] text-[10px] font-bold text-black/70">
        {notes.length}
      </span>
    </button>
  );
}

/**
 * The strip's ONE notes popover, anchored to the chip that opened it. A Radix
 * Popover, not the chip's hover tooltip: a tooltip closes the moment the
 * pointer leaves, which would eat a note being typed.
 */
export function TabNotesPopover({
  view,
  target,
  notes,
  anchor,
  onView,
  onClose,
}: {
  view: TabNotesView;
  target: NoteTarget;
  /** This entity's notes, newest first — from the strip's one notes query. */
  notes: readonly Annotation[];
  anchor: HTMLElement | null;
  onView: (view: TabNotesView) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);
  const note = view.mode === 'note' ? notes.find((n) => n.id === view.noteId) : undefined;
  if (!anchor) return null;
  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor virtualRef={anchorRef as React.RefObject<HTMLElement>} />
      <PopoverContent side="bottom" align="start" className="w-80 p-0" data-testid="tab-notes-popover">
        {view.mode === 'compose' && (
          <NoteComposer
            onCancel={onClose}
            onSave={async (content, color) => {
              await addNote(target, content, color);
              onView({ key: view.key, mode: 'list' });
            }}
          />
        )}
        {view.mode === 'list' && (
          <NotesList
            title={t`Notes · ${target.name}`}
            notes={notes}
            onAdd={() => onView({ key: view.key, mode: 'compose' })}
            onPick={(n) => onView({ key: view.key, mode: 'note', noteId: n.id })}
          />
        )}
        {view.mode === 'note' && note && (
          <NoteCard
            note={note}
            onSave={(patch) => saveNote(note, patch)}
            onDelete={async () => {
              await deleteNote(note);
              onView({ key: view.key, mode: notes.length > 1 ? 'list' : 'compose' });
            }}
            onClose={() => onView({ key: view.key, mode: 'list' })}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
