/**
 * The ribbon's artifacts chip — the surface that makes a registered deliverable
 * reachable at all.
 *
 * Two things are worth pinning. First, the chip shows the LATEST artifact by
 * `created_date`, not the list tail: the list arrives from a server query plus
 * bus deltas, and neither guarantees arrival order. Second — the rule the whole
 * artifact model rests on — clicking opens the REFERENCED ASSET, never the
 * artifact row. An artifact points at something; it is not the something.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Artifact } from '@sdk';
import { TerminalBottomRibbon } from '@src/components/terminal/interactive-terminal/TerminalBottomRibbon';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/components/view-mode', () => ({ useIsAdvanced: () => false }));
vi.mock('@src/components/prompt-library/PromptLibraryMenu', () => ({ PromptLibraryMenu: () => null }));

const baseProps = {
  fileCount: 0,
  isActive: true,
  openTabs: [],
  activeSideTab: null,
  onOpenSideTab: vi.fn(),
  process: null,
};

afterEach(() => cleanup());

let seq = 0;
const artifact = (name: string, createdDate: string, assetRef = `/repo/${name}`) =>
  new Artifact({
    id: `9c4d0e11-0000-4000-8000-0000000000${String(++seq).padStart(2, '0')}`,
    name,
    kind: 'content.file',
    asset_ref: assetRef,
    created_date: createdDate,
  } as never);

describe('TerminalBottomRibbon — artifacts chip', () => {
  it('renders nothing when the run registered no artifact', () => {
    render(<TerminalBottomRibbon {...baseProps} artifacts={[]} onOpenArtifact={vi.fn()} />);

    expect(screen.queryByLabelText('Choose an artifact to open')).toBeNull();
  });

  it('opens the REFERENCED ASSET on click, never the artifact row', async () => {
    const onOpenArtifact = vi.fn();
    render(
      <TerminalBottomRibbon
        {...baseProps}
        artifacts={[artifact('report.md', '2026-08-01T10:00:00Z')]}
        onOpenArtifact={onOpenArtifact}
      />,
    );

    await userEvent.click(screen.getByText('report.md'));

    expect(onOpenArtifact).toHaveBeenCalledWith('/repo/report.md');
  });

  it('shows the newest by created_date, not the list tail', () => {
    render(
      <TerminalBottomRibbon
        {...baseProps}
        artifacts={[
          artifact('newest.md', '2026-08-01T12:00:00Z'),
          artifact('older.md', '2026-08-01T09:00:00Z'),
        ]}
        onOpenArtifact={vi.fn()}
      />,
    );

    // Tail-order would surface `older.md`.
    expect(screen.getByText('newest.md')).toBeTruthy();
  });

  it('offers the rest through a popover, newest-first, when there are several', async () => {
    const onOpenArtifact = vi.fn();
    render(
      <TerminalBottomRibbon
        {...baseProps}
        artifacts={[
          artifact('older.md', '2026-08-01T09:00:00Z'),
          artifact('newest.md', '2026-08-01T12:00:00Z'),
        ]}
        onOpenArtifact={onOpenArtifact}
      />,
    );

    await userEvent.click(screen.getByLabelText('Choose an artifact to open'));
    await userEvent.click(screen.getByText('older.md'));

    expect(onOpenArtifact).toHaveBeenCalledWith('/repo/older.md');
  });

  it('shows no select affordance for a single artifact', () => {
    render(
      <TerminalBottomRibbon
        {...baseProps}
        artifacts={[artifact('only.md', '2026-08-01T10:00:00Z')]}
        onOpenArtifact={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('Choose an artifact to open')).toBeNull();
  });

  it('does not call the opener for an artifact with no referenced asset', async () => {
    const onOpenArtifact = vi.fn();
    render(
      <TerminalBottomRibbon
        {...baseProps}
        artifacts={[artifact('webapp', '2026-08-01T10:00:00Z', '')]}
        onOpenArtifact={onOpenArtifact}
      />,
    );

    await userEvent.click(screen.getByText('webapp'));

    expect(onOpenArtifact).not.toHaveBeenCalled();
  });
});
