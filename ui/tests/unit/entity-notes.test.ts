import { describe, expect, it } from 'vitest';
import { AgenticProcess, Annotation, TypeId } from '@sdk';
import { newNote, NOTE_LABEL, notesByTarget, notesOf, noteTitle } from '@src/hooks/use-entity-notes';
import { DEFAULT_NOTE_COLOR, NOTE_COLOR_TOKENS, NOTE_PALETTE, noteColor } from '@src/components/notes/note-palette';
import { buildNotePrompt, noteWorkerContext } from '@src/components/notes/useNoteWorker';

const PROC = new TypeId(AgenticProcess.type, 'd426b6f0-27d3-4d1d-a5b0-283fc0d160e7');
const OTHER = '7c0e7f8a-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const target = { typeId: PROC, name: 'token-sources-tree-allocate', dock: '{"page":"dock"}' };

function note(content: string, iso: string, extra: Partial<Annotation> = {}): Annotation {
  const n = newNote(target, content, 'pink');
  n.iso_timestamp = iso;
  Object.assign(n, extra);
  return n;
}

describe('newNote', () => {
  it('is a note: label, the entity it sits on, its colour, name and view', () => {
    const n = newNote(target, 'Ask Dana', 'blue');
    expect(n.labels).toEqual([NOTE_LABEL]);
    expect([n.target_type, n.target_id]).toEqual([PROC.type, PROC.id]);
    expect(n.data).toEqual({ color: 'blue', name: target.name, dock: target.dock });
    expect(n.content).toBe('Ask Dana');
  });
});

describe('notesOf', () => {
  it('keeps only notes, newest first — the first one colours the tab badge', () => {
    const old = note('old', '2026-10-20T10:00:00.000Z');
    const fresh = note('fresh', '2026-10-23T10:00:00.000Z');
    const comment = new Annotation({ labels: ['comment:'], content: 'x', iso_timestamp: '2026-10-24T00:00:00.000Z' });
    expect(notesOf([old, comment, fresh]).map((n) => n.content)).toEqual(['fresh', 'old']);
  });
});

describe('notesByTarget', () => {
  it('groups notes by the entity they sit on, keeping order', () => {
    const a = note('a', '2026-10-23T10:00:00.000Z');
    const b = note('b', '2026-10-22T10:00:00.000Z');
    const other = note('c', '2026-10-21T10:00:00.000Z', { target_id: OTHER });
    const grouped = notesByTarget([a, b, other]);
    expect(grouped.get(PROC.toString())?.map((n) => n.content)).toEqual(['a', 'b']);
    expect(grouped.get(new TypeId(PROC.type, OTHER).toString())?.map((n) => n.content)).toEqual(['c']);
  });
});

describe('noteTitle', () => {
  it('is the first line', () => {
    expect(noteTitle(note('line one\nline two', ''))).toBe('line one');
  });
});

describe('note palette', () => {
  it('every colour has a face, a fold, a flap and ink', () => {
    for (const token of NOTE_COLOR_TOKENS) {
      const c = NOTE_PALETTE[token];
      expect(c.face).toHaveLength(2);
      expect([c.fold, c.flap, c.ink].every((v) => /^#[0-9A-Fa-f]{6}$/.test(v))).toBe(true);
    }
  });

  it('an unknown or missing colour is the default', () => {
    expect(noteColor('magenta').token).toBe(DEFAULT_NOTE_COLOR);
    expect(noteColor(undefined).token).toBe(DEFAULT_NOTE_COLOR);
  });
});

describe('note context worker', () => {
  it('works on the note and the entity it sits on, in that order', () => {
    const n = note('Ask Dana', '2026-10-23T10:00:00.000Z', { id: 'note-1' });
    expect(noteWorkerContext(n).map((t) => t.toString())).toEqual([
      new TypeId(Annotation.type, 'note-1').toString(),
      PROC.toString(),
    ]);
  });

  it("the prompt carries the entity and the note's full text", () => {
    const n = note('Ask Dana about the allocation rule\nbefore merging', '2026-10-23T10:00:00.000Z', { id: 'note-1' });
    const prompt = buildNotePrompt(n);
    expect(prompt).toContain(`You are working on ${target.name} (${PROC.type}/${PROC.id})`);
    expect(prompt).toContain('Ask Dana about the allocation rule\nbefore merging');
  });
});
