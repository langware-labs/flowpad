/**
 * The per-turn "files created" chip row, as the transcript renders it.
 *
 * Three things are load-bearing and all three are silent when broken:
 *
 *  1. It must render with "Show tool calls" OFF. That is the default in
 *     Standard mode, and it is the only state in which a written file has no
 *     other trace in the chat — the entire reason the row exists.
 *  2. It must be OPT-IN. `TurnGroupsList` is shared with the floating Flowpad
 *     Assistant and the vibe chat; a default-on row would appear there too.
 *  3. Clicking a chip must open the file the agent actually wrote. A raw
 *     transcript path has no compute-node prefix, so the code editor resolves it
 *     against the ambient project root and 404s; and an assets pointer is
 *     scope-keyed, so a `.md` folds into the one Assets tab for the scope and
 *     renames it instead of opening beside it. The URL assertions below are the
 *     guards for both.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgenticProcess, FlowData, FlowElementTypes, instancePreferences, PrefKey } from '@sdk';
import type { TurnGroup } from '@src/components/floating-chat/groupTurnEvents';

// Stub the heavy leaf renderers so this isolates the chip row and its placement
// from their internals. The chip row itself is REAL, and so is navigation.
vi.mock('@src/components/floating-chat/ToolEntryRow', () => ({
  ToolEntryRow: () => <div data-testid="tool-entry-row" />,
}));
vi.mock('@src/components/entity-execution-panel/execution-message/execution-message', () => ({
  default: () => <div data-testid="execution-message" />,
}));
vi.mock('@src/components/entity-execution-panel/MetaMessageChip', () => ({
  MetaMessageChip: () => <div data-testid="meta-message-chip" />,
}));

import { isRenderedGroup, TurnGroupsList } from '@src/components/entity-execution-panel/TurnGroupsList';

const PROJECT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';

/** Only `workdir` and `project_id` are read off the process here. */
const processStub = (workdir: string | null = '/repo') =>
  ({ workdir, project_id: PROJECT_ID }) as unknown as AgenticProcess;

let seq = 0;

function wroteGroup(...paths: string[]): TurnGroup {
  const events = paths.map((path) => {
    const fd = new FlowData(FlowElementTypes.TOOL_CALL, JSON.stringify({ tool_call_id: `tu-${seq++}`, args: {} }), {
      i: String(seq),
      t: '2026-08-01T10:00:00Z',
      'data-type': 'object',
      subtype: 'file_write',
    });
    fd.processEntry = { transcript_entry: { kind: 'file_write', path } };
    return fd;
  });
  return { kind: 'dense', index: seq++, events };
}

function message(content: string, role: 'user' | 'assistant'): TurnGroup {
  const fd = new FlowData(
    role === 'user' ? FlowElementTypes.USER_MESSAGE : FlowElementTypes.CHAT,
    content,
    { i: String(seq++), t: '2026-08-01T10:00:00Z', 'data-type': 'string', role },
  );
  return { kind: 'message', index: seq, flowData: fd };
}

const oneTurn = (...paths: string[]): TurnGroup[] => [
  message('go', 'user'),
  wroteGroup(...paths),
  message('done', 'assistant'),
];

let lastPath = '';
function LocationProbe() {
  // Decoded: a VFS pointer carries `compute_node-@local`, which the URL
  // percent-encodes. Asserting on the readable form keeps the guards legible.
  lastPath = decodeURIComponent(useLocation().pathname);
  return null;
}

function renderList(props: Partial<Parameters<typeof TurnGroupsList>[0]> & { groups: TurnGroup[] }) {
  return render(
    <MemoryRouter initialEntries={['/dock/shell']}>
      <LocationProbe />
      <TurnGroupsList {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  lastPath = '';
  instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, false);
});
afterEach(() => {
  cleanup();
  instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, false);
});

describe('isRenderedGroup — the one visibility rule', () => {
  // The created-files plan has to agree with the render about which rows exist,
  // so the filter was lifted out of TurnGroupsList's JSX into this predicate.
  // These lock the extraction: same three rules, unchanged.
  it('keeps dense groups only when "Show tool calls" is on', () => {
    const group = wroteGroup('/repo/a.ts');

    expect(isRenderedGroup(group, false)).toBe(false);
    expect(isRenderedGroup(group, true)).toBe(true);
  });

  it('always keeps a worker-unavailable notice and a plain message', () => {
    expect(isRenderedGroup(message('hi', 'user'), false)).toBe(true);
  });

  it('drops the Flowpad prompt envelope, keeps other meta messages', () => {
    const envelope = message("# You are the 'x' agent\n# User message\ngo", 'user');
    envelope.flowData.attributes['is-meta'] = 'true';
    const skill = message('Base directory for this skill: /skills/x', 'user');
    skill.flowData.attributes['is-meta'] = 'true';

    expect(isRenderedGroup(envelope, false)).toBe(false);
    expect(isRenderedGroup(skill, false)).toBe(true);
  });
});

describe('TurnGroupsList — created-files chip row', () => {
  it('still shows dense tool rows when the pref is on', () => {
    instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, true);
    renderList({ groups: oneTurn('/repo/src/new.ts') });

    expect(screen.queryByTestId('tool-entry-row')).not.toBeNull();
  });

  it('is opt-in: the shared consumer that passes no flag gets no row', () => {
    // The floating assistant / vibe chat render shape. Must be untouched.
    renderList({ groups: oneTurn('/repo/src/new.ts') });

    expect(screen.queryByTestId('turn-created-files')).toBeNull();
  });

  it('renders a chip per created file when enabled', () => {
    renderList({ groups: oneTurn('/repo/src/new.ts', '/repo/README.md'), showCreatedFiles: true, process: processStub() });

    const chips = screen.getAllByTestId('turn-created-file-chip');
    expect(chips.map((c) => c.textContent)).toEqual(['new.ts', 'README.md']);
  });

  it('renders with "Show tool calls" OFF — the state the row exists for', () => {
    renderList({ groups: oneTurn('/repo/src/new.ts'), showCreatedFiles: true, process: processStub() });

    // No tool row at all, yet the created file is still reachable.
    expect(screen.queryByTestId('tool-entry-row')).toBeNull();
    expect(screen.getByTestId('turn-created-file-chip').textContent).toBe('new.ts');
  });

  it('waits for the trailing turn to end', () => {
    const groups = [message('go', 'user'), wroteGroup('/repo/src/new.ts')];

    const { unmount } = renderList({ groups, showCreatedFiles: true, process: processStub(), turnActive: true });
    expect(screen.queryByTestId('turn-created-files')).toBeNull();
    unmount();

    renderList({ groups, showCreatedFiles: true, process: processStub(), turnActive: false });
    expect(screen.queryByTestId('turn-created-files')).not.toBeNull();
  });

  it('places the row inside its own turn, before the next turn divider', () => {
    // If the row landed after the divider it would read as belonging to the
    // NEXT turn — the chips would credit the wrong prompt.
    renderList({
      groups: [...oneTurn('/repo/a.ts'), ...oneTurn('/repo/b.ts')],
      showCreatedFiles: true,
      process: processStub(),
    });

    const rows = screen.getAllByTestId('turn-created-files');
    expect(rows).toHaveLength(2);

    const first = rows[0];
    const secondTurnFirstMessage = screen.getAllByTestId('execution-message')[2];
    expect(first.compareDocumentPosition(secondTurnFirstMessage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('folds everything past the fourth file into a "+N" chip', () => {
    renderList({
      groups: oneTurn('/r/a.ts', '/r/b.ts', '/r/c.ts', '/r/d.ts', '/r/e.ts', '/r/f.ts'),
      showCreatedFiles: true,
      process: processStub(),
    });

    expect(screen.getAllByTestId('turn-created-file-chip')).toHaveLength(4);
    expect(screen.getByTestId('turn-created-files-more').textContent).toBe('+2');
  });
});

describe('created-file chip — what a click opens', () => {
  it('opens a code file with its compute-node prefix, not a bare project-root path', () => {
    renderList({ groups: oneTurn('/repo/src/new.ts'), showCreatedFiles: true, process: processStub() });

    fireEvent.click(screen.getByTestId('turn-created-file-chip'));

    // Without the machine→VFS conversion this is `/dock/editor/repo/src/new.ts`,
    // which the code editor resolves against the ambient project and 404s.
    expect(lastPath).toContain('/dock/editor/');
    expect(lastPath).toContain('compute_node-@local/repo/src/new.ts');
  });

  it('opens a markdown file rebased onto the project, so it gets its own tab', () => {
    renderList({ groups: oneTurn('/repo/NOTES.md'), showCreatedFiles: true, process: processStub() });

    fireEvent.click(screen.getByTestId('turn-created-file-chip'));

    // A bare `/dock/assets/…` pointer is SCOPE-keyed: it would fold into the
    // scope's single Assets tab and rename it. The project rebase is what mints
    // a tab of its own.
    expect(lastPath).toContain(`/dock/project/${PROJECT_ID}/`);
    expect(lastPath).toContain('markdown');
    expect(lastPath).toContain('compute_node-@local/repo/NOTES.md');
  });

  it('anchors a Codex-relative path on the process workdir', () => {
    renderList({ groups: oneTurn('docs/hello.md'), showCreatedFiles: true, process: processStub('/repo') });

    fireEvent.click(screen.getByTestId('turn-created-file-chip'));

    expect(lastPath).toContain('compute_node-@local/repo/docs/hello.md');
  });

  it('leaves a chip inert rather than guessing when the path cannot be anchored', () => {
    renderList({ groups: oneTurn('docs/hello.md'), showCreatedFiles: true, process: processStub(null) });

    const chip = screen.getByTestId('turn-created-file-chip');
    expect((chip as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(chip);
    expect(lastPath).toBe('/dock/shell');
  });
});
