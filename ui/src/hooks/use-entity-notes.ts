import { Annotation, ExpressionNode, QueryFilter, QueryRequest, TypeId, type AnnotationSubkind } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { DEFAULT_NOTE_COLOR, type NoteColorToken } from '@src/components/notes/note-palette';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { useMemo } from 'react';

/**
 * Sticky notes are `Annotation` rows of subkind `note`, pointing at the entity
 * they sit on through `target_type` / `target_id`; `data.color` is a note
 * palette token, `data.name` the entity's name and `data.dock` the tab's
 * `DockPointer` JSON when the note was written — what "Open" goes back to, the
 * same lossless round-trip a "bookmark what's open" favorite uses.
 *
 * ONE live query serves every surface (tab badges, the tab popover, the
 * Bookmarks list): writes need no refetch, the subscription splices them in.
 * The hub has no `annotation` entity, so notes are off in hub mode — the same
 * rule bookmarks follow.
 */
/** A quick prompt is a note too, so both subkinds are notes. */
export const NOTE_SUBKINDS: readonly AnnotationSubkind[] = ['note', 'quick_prompt'];

/** Where a note sits: the entity, its name and the view it was written on. */
export interface NoteTarget {
  typeId: TypeId;
  name: string;
  dock?: string | null;
}

/** The notes among `annotations`, newest first — the first one colours the tab badge. */
export function notesOf(annotations: readonly Annotation[]): Annotation[] {
  return annotations
    .filter((a) => !!a.subkind && NOTE_SUBKINDS.includes(a.subkind))
    .sort((a, b) => noteTime(b).localeCompare(noteTime(a)));
}

function noteTime(a: Annotation): string {
  return a.iso_timestamp || String(a.created_date ?? '');
}

/** The note's first line, for list rows. */
export function noteTitle(note: Annotation): string {
  return (note.content ?? '').trim().split('\n')[0] ?? '';
}

/** The key a note is grouped under: its target's TypeId string. */
export function noteTargetKey(note: Annotation): string | null {
  return note.target_type && note.target_id ? new TypeId(note.target_type, note.target_id).toString() : null;
}

/** TypeId string → that entity's notes, newest first (input order is kept). */
export function notesByTarget(notes: readonly Annotation[]): Map<string, Annotation[]> {
  const out = new Map<string, Annotation[]>();
  for (const n of notes) {
    const key = noteTargetKey(n);
    if (!key) continue;
    const list = out.get(key);
    if (list) list.push(n);
    else out.set(key, [n]);
  }
  return out;
}

export function newNote(
  target: NoteTarget,
  content: string,
  color: NoteColorToken = DEFAULT_NOTE_COLOR,
  extra: { subkind?: AnnotationSubkind; data?: Record<string, unknown> } = {},
): Annotation {
  return new Annotation({
    subkind: extra.subkind ?? 'note',
    target_type: target.typeId.type,
    target_id: target.typeId.id,
    content,
    data: { color, name: target.name, ...(target.dock ? { dock: target.dock } : {}), ...extra.data },
    iso_timestamp: new Date().toISOString(),
  });
}

export async function addNote(target: NoteTarget, content: string, color: NoteColorToken): Promise<void> {
  await newNote(target, content, color).save([]);
}

export async function saveNote(
  note: Annotation,
  patch: { content?: string; color?: NoteColorToken; data?: Record<string, unknown> },
): Promise<void> {
  if (patch.content !== undefined) note.content = patch.content;
  if (patch.color || patch.data)
    note.data = { ...note.data, ...patch.data, ...(patch.color ? { color: patch.color } : {}) };
  await note.save([]);
}

export async function deleteNote(note: Annotation): Promise<void> {
  await note.delete();
}

/** Every note, on any entity, newest first. The subkind is matched on the server, so other annotations
 *  (terminal comments, lock flags) never come down. */
export function useAllNotes(enabled = true): Annotation[] {
  const request = useMemo(
    () =>
      new QueryRequest({
        type: Annotation.type,
        scope: [],
        query: new QueryFilter({ match: new ExpressionNode({ op: '$IN', operands: ['subkind', [...NOTE_SUBKINDS]] }) }),
        name: 'allNotes',
      }),
    [],
  );
  const { data = [] } = useEntitiesQuery<Annotation>(request, { enabled: enabled && !isHubOnly() });
  return useMemo(() => notesOf(data), [data]);
}

/**
 * Quick prompts are notes too — subkind `quick_prompt` counts as a note, so they keep every note
 * behaviour. Scope is the target: the user (`Mine`, every project) or the project. `data.last_used_at`
 * orders the list; a click or a "save last prompt" stamps it.
 */
export interface QuickPromptOwners {
  userId?: string | null;
  projectId?: string | null;
}

export function quickPromptTime(note: Annotation): string {
  const used = (note.data as { last_used_at?: string } | undefined)?.last_used_at;
  return used || noteTime(note);
}

/** This user's and this project's quick prompts, last used first. */
export function quickPromptsFor(annotations: readonly Annotation[], owners: QuickPromptOwners): Annotation[] {
  const ownerOf: Record<string, string | null | undefined> = { user: owners.userId, project: owners.projectId };
  return annotations
    .filter((a) => {
      const id = a.target_type ? ownerOf[a.target_type] : null;
      return !!id && a.target_id === id && a.subkind === 'quick_prompt';
    })
    .sort((a, b) => quickPromptTime(b).localeCompare(quickPromptTime(a)));
}

export async function addQuickPrompt(
  content: string,
  owner: { type: 'user' | 'project'; id: string; name: string },
): Promise<void> {
  const target = { typeId: new TypeId(owner.type, owner.id), name: owner.name };
  const used = { last_used_at: new Date().toISOString() };
  await newNote(target, content, DEFAULT_NOTE_COLOR, { subkind: 'quick_prompt', data: used }).save([]);
}

export async function touchQuickPrompt(note: Annotation): Promise<void> {
  await saveNote(note, { data: { last_used_at: new Date().toISOString() } });
}

/** Quick prompts are notes, so they ride the one notes query — no second subscription. */
export function useQuickPrompts(owners: QuickPromptOwners, enabled = true): Annotation[] {
  const notes = useAllNotes(enabled);
  return useMemo(() => quickPromptsFor(notes, owners), [notes, owners.userId, owners.projectId]);
}
