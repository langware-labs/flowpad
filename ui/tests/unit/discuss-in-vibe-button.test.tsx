import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscussInVibeButton } from '@src/components/assets/editor/AssetDiscussButton';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { DockPointer } from '@src/navigation/DockPointer';

afterEach(cleanup);

const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const renderButton = (node: React.ReactNode) =>
  render(<TooltipProvider delayDuration={0}>{node}</TooltipProvider>);

describe('DiscussInVibeButton', () => {
  it('discusses THIS asset in its project — a Vibe host tab with the asset as its child', () => {
    // `navigation.discussAsset` resumes the last chat about the asset (or makes one),
    // places its host tab, and opens the asset under it; the button only asks.
    const discussAsset = vi.fn(() => Promise.resolve());
    const dock = DockPointer.forFile('/project/src/main.ts', { line: 12, column: 4 });

    renderButton(<DiscussInVibeButton dock={dock} projectId={PROJECT} navigation={{ discussAsset }} />);
    fireEvent.click(screen.getByTestId('asset-discuss-in-vibe'));

    expect(discussAsset).toHaveBeenCalledTimes(1);
    expect(discussAsset).toHaveBeenCalledWith(dock, PROJECT);
  });

  it('renders as a compact icon-only action with an accessible tooltip label', () => {
    renderButton(
      <DiscussInVibeButton
        dock={DockPointer.forFile('/project/note.md')}
        projectId={PROJECT}
        navigation={{ discussAsset: vi.fn() }}
      />,
    );

    const button = screen.getByTestId('asset-discuss-in-vibe');
    expect(button.getAttribute('aria-label')).toBe('Discuss');
    expect(button.classList.contains('h-7')).toBe(true);
    expect(button.classList.contains('w-7')).toBe(true);
    expect(button.textContent).toBe('');
  });

  it('leaves the projectless seam disabled without discussing', () => {
    const discussAsset = vi.fn();
    renderButton(
      <DiscussInVibeButton
        dock={DockPointer.forFile('/tmp/note.txt')}
        projectId={null}
        navigation={{ discussAsset }}
        disabled
      />,
    );

    fireEvent.click(screen.getByTestId('asset-discuss-in-vibe'));
    expect(discussAsset).not.toHaveBeenCalled();
  });
});
