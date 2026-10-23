import { useState } from 'react';
import type { Annotation } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { ExternalLink, Plus, Trash2, X } from 'lucide-react';
import { ColorPicker } from '@src/components/ui/color-picker';
import { ContextWorkerToolbar } from '@src/components/workers/ContextWorkerToolbar';
import { noteTitle } from '@src/hooks/use-entity-notes';
import { formatTimeAgoShort } from '@src/utils/format-time-ago';
import { DEFAULT_NOTE_COLOR, NOTE_COLOR_TOKENS, NOTE_PALETTE, noteColor, type NoteColorToken } from './note-palette';
import { StickyNoteShape } from './StickyNoteShape';
import { useNoteWorker } from './useNoteWorker';

/** The note swatches as the shared ColorPicker reads them: a token and the colour it shows. */
const SWATCHES = NOTE_COLOR_TOKENS.map((token) => ({ token, hex: NOTE_PALETTE[token].face[1] }));

function NoteColorPicker({ value, onChange }: { value: NoteColorToken; onChange: (c: NoteColorToken) => void }) {
  return (
    <ColorPicker
      palette={SWATCHES}
      allowNone={false}
      value={NOTE_PALETTE[value].face[1]}
      onChange={(hex) => {
        const hit = SWATCHES.find((s) => s.hex === hex);
        if (hit) onChange(hit.token);
      }}
      size="sm"
      className="gap-1"
    />
  );
}

/** The paper itself: the note's colour, with the folded corner cut out. */
function NotePaper({ color, children }: { color: string | undefined; children: React.ReactNode }) {
  const c = noteColor(color);
  return (
    <div
      className="relative px-3.5 pb-6 pt-3"
      style={{
        background: `linear-gradient(${c.face[0]}, ${c.face[1]})`,
        color: c.ink,
        clipPath: 'polygon(0 0, 100% 0, 100% calc(100% - 22px), calc(100% - 22px) 100%, 0 100%)',
      }}
    >
      {children}
    </div>
  );
}

export function NoteComposer({
  onSave,
  onCancel,
}: {
  onSave: (content: string, color: NoteColorToken) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const [text, setText] = useState('');
  const [color, setColor] = useState<NoteColorToken>(DEFAULT_NOTE_COLOR);
  const save = () => {
    if (text.trim()) void onSave(text.trim(), color);
  };
  return (
    <div className="space-y-2 p-2.5" data-testid="note-composer">
      <div className="flex items-center gap-1.5">
        <StickyNoteShape color={color} size={14} />
        <p className="text-sm font-semibold text-foreground">
          <Trans>New note</Trans>
        </p>
      </div>
      <NotePaper color={color}>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
          }}
          placeholder={t`Write a note…`}
          className="h-20 w-full resize-none border-0 bg-transparent text-xs outline-none placeholder:text-current placeholder:opacity-50"
          data-testid="note-composer-text"
        />
      </NotePaper>
      <div className="flex items-center gap-1.5">
        <NoteColorPicker value={color} onChange={setColor} />
        <span className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
        >
          <Trans>Cancel</Trans>
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!text.trim()}
          data-testid="note-composer-save"
          className="rounded bg-primary px-2 py-1 text-[11px] text-primary-foreground disabled:opacity-50"
        >
          <Trans>Save</Trans>
        </button>
      </div>
    </div>
  );
}

/** One row: the note's sticky, its first line, and (in the Bookmarks list) the entity it is on. */
export function NoteRow({ note, showEntity, onPick }: { note: Annotation; showEntity?: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      data-testid="note-row"
      className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-start hover:bg-muted"
    >
      <StickyNoteShape color={note.data?.color as string | undefined} size={showEntity ? 16 : 18} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-foreground">{noteTitle(note)}</span>
        {showEntity && (
          <span className="block truncate text-[10px] text-muted-foreground">{(note.data?.name as string) ?? ''}</span>
        )}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground">{formatTimeAgoShort(note.iso_timestamp)}</span>
    </button>
  );
}

export function NotesList({
  title,
  notes,
  onPick,
  onAdd,
}: {
  title: string;
  notes: readonly Annotation[];
  onPick: (note: Annotation) => void;
  onAdd: () => void;
}) {
  return (
    <div data-testid="notes-list">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{title}</p>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-foreground hover:bg-muted"
        >
          <Plus className="h-3 w-3" />
          <Trans>Add</Trans>
        </button>
      </div>
      <div className="space-y-0.5 p-1.5">
        {notes.map((n) => (
          <NoteRow key={n.id} note={n} onPick={() => onPick(n)} />
        ))}
      </div>
    </div>
  );
}

/**
 * The full note: its text (click to edit), colour, delete — and the context
 * worker toolbar, which starts a worker on this note or opens the one it has.
 * `onOpenEntity` adds "Open" for the entity the note sits on (Bookmarks).
 */
export function NoteCard({
  note,
  onSave,
  onDelete,
  onClose,
  onOpenEntity,
}: {
  note: Annotation;
  onSave: (patch: { content?: string; color?: NoteColorToken }) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  onClose: () => void;
  onOpenEntity?: () => void;
}) {
  const { t } = useLingui();
  const [editing, setEditing] = useState<string | null>(null);
  const color = noteColor(note.data?.color).token;
  const worker = useNoteWorker(note);
  return (
    <div data-testid="note-card">
      <NotePaper color={color}>
        <div className="mb-2 flex items-center gap-1.5">
          <span className="flex-1 whitespace-nowrap text-[10px] opacity-70">
            {formatTimeAgoShort(note.iso_timestamp)}
          </span>
          <NoteColorPicker value={color} onChange={(c) => void onSave({ color: c })} />
          <button
            type="button"
            title={t`Delete note`}
            onClick={() => void onDelete()}
            className="ms-1 opacity-70 hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button type="button" title={t`Close`} onClick={onClose} className="opacity-70 hover:opacity-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {editing === null ? (
          <p
            className="cursor-text whitespace-pre-wrap text-[13px] leading-snug"
            onClick={() => setEditing(note.content ?? '')}
            data-testid="note-card-text"
          >
            {note.content}
          </p>
        ) : (
          <textarea
            autoFocus
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onBlur={() => {
              if (editing.trim() && editing !== note.content) void onSave({ content: editing.trim() });
              setEditing(null);
            }}
            className="h-24 w-full resize-none border-0 bg-transparent text-[13px] leading-snug outline-none"
          />
        )}
      </NotePaper>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border p-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {onOpenEntity ? (
            <Trans>
              on <b className="text-foreground">{(note.data?.name as string) ?? ''}</b>
            </Trans>
          ) : (
            <Trans>Work on this note</Trans>
          )}
        </span>
        <ContextWorkerToolbar
          onLaunch={worker.launch}
          hasProcess={!!worker.process}
          onOpen={worker.open}
          sessionName={worker.process?.name ?? undefined}
          starting={worker.starting}
          testIdPrefix="note"
        />
        {onOpenEntity && (
          <button
            type="button"
            onClick={onOpenEntity}
            data-testid="note-open-entity"
            className="inline-flex h-7 items-center gap-1 rounded bg-primary px-2 text-[11px] text-primary-foreground"
          >
            <Trans>Open</Trans>
            <ExternalLink className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}
