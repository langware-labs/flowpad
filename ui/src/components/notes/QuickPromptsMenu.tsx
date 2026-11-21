import { useMemo, useRef, useState } from 'react';
import { Annotation } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { Briefcase, Check, FolderPlus, Pencil, Plus, Trash2, User } from 'lucide-react';
import { BrowseableTree } from '@src/components/browseable-tree/BrowseableTree';
import { groupRoot } from '@src/components/browseable-tree/adapters/groupRoot';
import { useMenuDialogs } from '@src/components/ui/browseable-menu';
import { useGroupTreeRefresh } from '@src/hooks/useGroupTreeRefresh';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@src/components/ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useAuth } from '@src/hooks/useAuth';
import {
  addQuickPrompt,
  deleteNote,
  noteTitle,
  quickPromptMatch,
  quickPromptTime,
  reorderQuickPrompt,
  saveNote,
  sortQuickPrompts,
  touchQuickPrompt,
  useQuickPrompts,
} from '@src/hooks/use-entity-notes';
import { formatTimeAgoShort } from '@src/utils/format-time-ago';
import { noteColor } from './note-palette';
import { NoteColorPicker } from './NoteViews';
import { StickyNoteShape } from './StickyNoteShape';

/** The folder tree the quick prompts live in (docs/entities-groups.md). */
export const QUICK_PROMPTS_NAMESPACE = 'quick-prompts';
const EXPANDED_KEY = 'flowpad.quickPrompts.expanded';
const LEAF_TYPES = [Annotation.type];

/**
 * The terminal bar's quick prompts: saved notes (yours, and this project's) that one click types into
 * the session and submits. A Popover, not a tooltip — the inline box must survive the pointer leaving.
 * Folders, moving and the manual order all come from the generic groups layer (`groupRoot`).
 */
export function QuickPromptsMenu({
  projectId,
  lastPromptText,
  isActive,
  onSend,
}: {
  projectId?: string | null;
  /** The session's last prompt — offered at the bottom to save as a quick prompt (never sent from there). */
  lastPromptText?: string | null;
  /** The worker's status, kept as a dot on the button (it replaced the status LED). */
  isActive: boolean;
  onSend: (text: string) => void;
}) {
  const { t } = useLingui();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const prompts = useQuickPrompts({ userId: user?.id, projectId }, open);
  const last = lastPromptText?.trim() ?? '';
  const offerLast = !!last && !!user?.id && !prompts.some((p) => (p.content ?? '').trim() === last);

  const run = (note: Annotation) => {
    onSend(note.content ?? '');
    setOpen(false);
    void touchQuickPrompt(note);
  };
  const saveMine = (text: string) => {
    if (user?.id) void addQuickPrompt(text, { type: 'user', id: user.id, name: user.name ?? '' }, prompts);
  };

  const { requestName, confirm, dialogs, open: asking } = useMenuDialogs();
  // The tree's rows outlive a render, so they reach the current `run` through a ref.
  const runRef = useRef(run);
  runRef.current = run;
  const leafMatch = useMemo(() => quickPromptMatch({ userId: user?.id, projectId }), [user?.id, projectId]);
  const tree = useMemo(
    () =>
      groupRoot({
        namespace: QUICK_PROMPTS_NAMESPACE,
        label: t`Quick prompts`,
        leafTypes: LEAF_TYPES,
        leafMatch,
        order: {
          sort: (members) => sortQuickPrompts(members as Annotation[]),
          reorder: (siblings, dragId, anchor) => reorderQuickPrompt(siblings as Annotation[], dragId, anchor),
        },
        leafToBrowseable: (entity) => {
          const note = entity as Annotation;
          return {
            label: noteTitle(note),
            pointer: null,
            content: <QuickPromptRow note={note} onRun={() => runRef.current(note)} />,
          };
        },
        requestName,
        confirm,
      }),
    [leafMatch, requestName, confirm, t],
  );
  const roots = useMemo(() => [tree.root], [tree]);
  useGroupTreeRefresh(tree.root.id, LEAF_TYPES, open, leafMatch);

  return (
    <Popover open={open} onOpenChange={(next) => (next || !asking) && setOpen(next)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t`Quick prompts`}
          aria-label={t`Quick prompts`}
          data-testid="quick-prompts-button"
          className="relative inline-flex h-6 w-6 items-center justify-center rounded hover:bg-muted"
        >
          <StickyNoteShape size={14} />
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ${isActive ? 'bg-emerald-500' : 'bg-red-500'}`}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-max min-w-80 max-w-[70vw] p-0"
        data-testid="quick-prompts-popover"
      >
        <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            <Trans>Quick prompts</Trans>
          </p>
          <span className="text-[10px] text-muted-foreground">
            <Trans>Click to run · drag to order</Trans>
          </span>
          <button
            type="button"
            title={t`New folder`}
            aria-label={t`New folder`}
            onClick={() => void tree.newFolder()}
            data-testid="quick-prompts-new-folder"
            className={ROW_BUTTON}
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="max-h-80 space-y-0.5 overflow-y-auto p-1.5">
          {prompts.length === 0 && (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">
              <Trans>No quick prompts yet. Type one below and press Enter.</Trans>
            </p>
          )}
          {open && <BrowseableTree roots={roots} activePointer={null} persistKey={EXPANDED_KEY} rootless />}
          <div className="mt-1 flex items-center gap-1.5 border-t border-border px-1.5 pt-2">
            <ScopeIcon project={false} />
            <input
              data-testid="quick-prompt-input"
              placeholder={t`Add new quick prompt…`}
              onKeyDown={(e) => {
                const text = e.currentTarget.value.trim();
                if (e.key !== 'Enter' || e.nativeEvent.isComposing || !text) return;
                e.preventDefault();
                saveMine(text);
                e.currentTarget.value = '';
              }}
              className="h-6 min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          {offerLast && (
            <HoverCard openDelay={300} closeDelay={0}>
              <HoverCardTrigger asChild>
                <button
                  type="button"
                  onClick={() => saveMine(last)}
                  data-testid="quick-prompt-last"
                  // w-0 + min-w-full: fills the menu without its long text setting the menu's width.
                  className="mt-1 flex w-0 min-w-full items-center gap-1.5 rounded px-1.5 py-1.5 text-start text-xs text-muted-foreground hover:bg-muted"
                >
                  <Plus className="h-3 w-3 shrink-0" />
                  <span className="shrink-0">
                    <Trans>Last in this session:</Trans>
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{last}</span>
                </button>
              </HoverCardTrigger>
              <HoverCardContent
                side="right"
                align="end"
                className="w-[28rem] max-w-[90vw] p-0"
                data-testid="quick-prompt-last-card"
              >
                <div className="border-b border-border px-3 py-2">
                  <p className="text-sm font-semibold text-foreground">
                    <Trans>Save as a quick prompt</Trans>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <Trans>Click to keep this session&apos;s last prompt. It is saved, not run.</Trans>
                  </p>
                </div>
                <p className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-sm leading-relaxed text-foreground">
                  {last}
                </p>
              </HoverCardContent>
            </HoverCard>
          )}
        </div>
      </PopoverContent>
      {dialogs}
    </Popover>
  );
}

const ROW_BUTTON = 'shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground';

/** One saved prompt: click runs it, its note picks its colour, the pencil edits its text in place, and
 *  delete takes two clicks. */
function QuickPromptRow({ note, onRun }: { note: Annotation; onRun: () => void }) {
  const { t } = useLingui();
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  // Delete takes two clicks: the first arms it (the bin turns into a check), the second deletes.
  const [armed, setArmed] = useState(false);
  const deleteLabel = armed ? t`Confirm: Delete` : t`Delete`;

  return (
    <div data-testid="quick-prompt-row" className="flex w-full items-center gap-2">
      <ScopeIcon project={note.target_type === 'project'} />
      <Popover open={picking} onOpenChange={setPicking}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={t`Color`}
            aria-label={t`Color`}
            data-testid="quick-prompt-color"
            className="shrink-0 rounded hover:bg-muted"
          >
            <StickyNoteShape color={note.data?.color as string | undefined} size={18} />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-auto p-2" data-testid="quick-prompt-color-picker">
          <NoteColorPicker
            value={noteColor(note.data?.color).token}
            onChange={(color) => {
              if (color) void saveNote(note, { color });
              setPicking(false);
            }}
          />
        </PopoverContent>
      </Popover>
      {editing ? (
        <textarea
          autoFocus
          rows={Math.min(6, (note.content ?? '').split('\n').length)}
          defaultValue={note.content ?? ''}
          data-testid="quick-prompt-edit-input"
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            const text = e.currentTarget.value.trim();
            if (text && text !== (note.content ?? '').trim()) void saveNote(note, { content: text });
            setEditing(false);
          }}
          className="min-w-0 flex-1 resize-none rounded border border-border bg-transparent px-1.5 py-0.5 text-xs text-foreground outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={onRun}
          data-testid="quick-prompt-run"
          className="flex min-w-0 flex-1 items-center text-start"
        >
          <span className="block min-w-0 flex-1 truncate text-xs text-foreground">{noteTitle(note)}</span>
        </button>
      )}
      <span className="shrink-0 text-[10px] text-muted-foreground">{formatTimeAgoShort(quickPromptTime(note))}</span>
      <button
        type="button"
        title={t`Edit`}
        aria-label={t`Edit`}
        onClick={() => setEditing(true)}
        data-testid="quick-prompt-edit"
        className={ROW_BUTTON}
      >
        <Pencil className="h-3 w-3" />
      </button>
      <button
        type="button"
        title={deleteLabel}
        aria-label={deleteLabel}
        onClick={() => (armed ? void deleteNote(note) : setArmed(true))}
        onPointerLeave={() => setArmed(false)}
        onBlur={() => setArmed(false)}
        data-armed={armed || undefined}
        data-testid="quick-prompt-delete"
        className={
          armed ? 'shrink-0 rounded bg-destructive/10 p-0.5 text-destructive hover:bg-destructive/20' : ROW_BUTTON
        }
      >
        {armed ? <Check className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
      </button>
    </div>
  );
}

function ScopeIcon({ project }: { project: boolean }) {
  const { t } = useLingui();
  const Icon = project ? Briefcase : User;
  return (
    <span className="shrink-0 text-muted-foreground" title={project ? t`This project` : t`Mine — every project`}>
      <Icon className="h-3 w-3" />
    </span>
  );
}
