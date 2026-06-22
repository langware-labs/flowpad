import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgenticProcess, dataManager, type MarkdownDoc } from '@sdk';
import { TerminalBottomRibbon } from '@src/components/terminal/interactive-terminal/TerminalBottomRibbon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the ribbon light: stub the view-mode hook + Prompt Library so the test
// renders just the ribbon chrome and our docs chip.
vi.mock('@src/components/view-mode', () => ({
  useIsAdvanced: () => false,
}));
vi.mock('@src/components/prompt-library/PromptLibraryMenu', () => ({
  PromptLibraryMenu: () => null,
}));

const baseProps = {
  fileCount: 0,
  isActive: true,
  openTabs: [],
  activeSideTab: null,
  onOpenSideTab: vi.fn(),
  process: null,
};

afterEach(() => cleanup());

describe('AgenticProcess — markdown.create wire update reaches the model + chip', () => {
  beforeEach(async () => {
    await dataManager.clearCache();
  });
  afterEach(async () => {
    await dataManager.clearCache();
  });

  it('applies a backend markdown_docs update over the wire and the chip then shows it', () => {
    const process = new AgenticProcess({ id: '00000000-0000-4000-8000-0000000000aa' });
    expect(process.markdown_docs).toEqual([]);

    // Simulate the entity-update the backend save() broadcasts after writing
    // hello.md — the same deepAssign path the FlowSync store drives on every WS
    // entity-op. This is the real receive path, not a hand-set prop.
    dataManager.deepAssign(process, {
      markdown_docs: [{ path: '/repo/hello.md', name: 'hello.md', change: 'create' }],
    });
    expect(process.markdown_docs).toEqual([
      { path: '/repo/hello.md', name: 'hello.md', change: 'create' },
    ]);

    // The ribbon, driven by the received field, surfaces the doc.
    render(
      <TerminalBottomRibbon {...baseProps} markdownDocs={process.markdown_docs} onOpenMarkdown={vi.fn()} />,
    );
    expect(screen.getByText('hello.md')).toBeTruthy();
  });

  it('a second write arrives as a grown list (deepAssign never corrupts order)', () => {
    const process = new AgenticProcess({ id: '00000000-0000-4000-8000-0000000000bb' });
    dataManager.deepAssign(process, {
      markdown_docs: [{ path: '/repo/hello.md', name: 'hello.md', change: 'create' }],
    });
    // Backend sends the full list (tail = latest) on the next save.
    dataManager.deepAssign(process, {
      markdown_docs: [
        { path: '/repo/hello.md', name: 'hello.md', change: 'create' },
        { path: '/repo/notes.md', name: 'notes.md', change: 'create' },
      ],
    });
    expect(process.markdown_docs.map((d) => d.name)).toEqual(['hello.md', 'notes.md']);
  });
});

describe('TerminalBottomRibbon — markdown docs chip', () => {
  it('renders no docs chip when the process authored nothing', () => {
    render(<TerminalBottomRibbon {...baseProps} markdownDocs={[]} onOpenMarkdown={vi.fn()} />);
    expect(screen.queryByText('hello.md')).toBeNull();
    expect(screen.queryByLabelText('Choose a doc to open')).toBeNull();
  });

  it('shows a single chip (no chevron) and opens hello.md on click', async () => {
    const docs: MarkdownDoc[] = [{ path: '/repo/hello.md', name: 'hello.md', change: 'create' }];
    const onOpenMarkdown = vi.fn();

    render(<TerminalBottomRibbon {...baseProps} markdownDocs={docs} onOpenMarkdown={onOpenMarkdown} />);

    // The event was "received": the chip surfaces the created doc.
    const chip = screen.getByText('hello.md');
    expect(chip).toBeTruthy();
    // One doc → no select affordance.
    expect(screen.queryByLabelText('Choose a doc to open')).toBeNull();

    await userEvent.click(chip);
    expect(onOpenMarkdown).toHaveBeenCalledWith('/repo/hello.md');
  });

  it('shows the latest doc and a chevron popover listing the rest when there are several', async () => {
    const docs: MarkdownDoc[] = [
      { path: '/repo/hello.md', name: 'hello.md', change: 'create' },
      { path: '/repo/notes.md', name: 'notes.md', change: 'update' },
    ];
    const onOpenMarkdown = vi.fn();

    render(<TerminalBottomRibbon {...baseProps} markdownDocs={docs} onOpenMarkdown={onOpenMarkdown} />);

    // Latest (tail) is shown on the chip body.
    expect(screen.getByText('notes.md')).toBeTruthy();

    // The subtle select appears only when >1; open it and pick the older doc.
    await userEvent.click(screen.getByLabelText('Choose a doc to open'));
    await userEvent.click(screen.getByText('hello.md'));
    expect(onOpenMarkdown).toHaveBeenCalledWith('/repo/hello.md');
  });
});
