/**
 * Render (jsdom, no backend) of the sticky-note pieces that take their notes as props: the
 * tab badge (count + newest note's colour), the hover "Add a note" button, and
 * the notes list. No mocks — the data hooks are covered by entity-notes.test.ts.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AgenticProcess, TypeId } from '@sdk';
import { newNote } from '@src/hooks/use-entity-notes';
import { TabNoteButton, TabNotesBadge } from '@src/components/notes/TabNotes';
import { NotesList } from '@src/components/notes/NoteViews';

afterEach(cleanup);

const target = {
  typeId: new TypeId(AgenticProcess.type, 'd426b6f0-27d3-4d1d-a5b0-283fc0d160e7'),
  name: 'token-sources',
};

function notes() {
  const fresh = newNote(target, 'Ask Dana\nabout the rule', 'pink');
  fresh.id = 'n1';
  const old = newNote(target, 'Re-run the suite', 'blue');
  old.id = 'n2';
  return [fresh, old];
}

describe('TabNotesBadge', () => {
  it('shows how many notes, in the first (newest) note colour', () => {
    render(<TabNotesBadge notes={notes()} onClick={() => {}} />);
    const badge = screen.getByTestId('tab-notes-badge');
    expect(badge).toHaveTextContent('2');
    expect(badge).toHaveAttribute('data-note-color', 'pink');
  });

  it('renders nothing for an entity with no notes', () => {
    const { container } = render(<TabNotesBadge notes={[]} onClick={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a click opens the list and never reaches the chip', async () => {
    let opened = 0;
    let chipClicks = 0;
    render(
      <div onClick={() => chipClicks++}>
        <TabNotesBadge notes={notes()} onClick={() => opened++} />
      </div>,
    );
    await userEvent.click(screen.getByTestId('tab-notes-badge'));
    expect([opened, chipClicks]).toEqual([1, 0]);
  });
});

describe('TabNoteButton', () => {
  it('opens the composer and never selects the tab', async () => {
    let composing = 0;
    let chipClicks = 0;
    render(
      <div onClick={() => chipClicks++}>
        <TabNoteButton onClick={() => composing++} />
      </div>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add a note' }));
    expect([composing, chipClicks]).toEqual([1, 0]);
  });
});

describe('NotesList', () => {
  it('lists each note by its first line; picking one hands it back', async () => {
    const picked: string[] = [];
    render(<NotesList title="Notes" notes={notes()} onAdd={() => {}} onPick={(n) => picked.push(n.id)} />);
    const rows = screen.getAllByTestId('note-row');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Ask Dana'),
      expect.stringContaining('Re-run the suite'),
    ]);
    expect(rows[0]).not.toHaveTextContent('about the rule');
    await userEvent.click(rows[1]);
    expect(picked).toEqual(['n2']);
  });
});
