import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscussInVibeButton } from '@src/components/assets/editor/AssetDiscussButton';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewMode } from '@src/contexts/view-mode-context';

afterEach(cleanup);

const renderButton = (node: React.ReactNode) =>
  render(<TooltipProvider delayDuration={0}>{node}</TooltipProvider>);

describe('DiscussInVibeButton', () => {
  it('navigates exactly once to the same dock with only viewMode changed', () => {
    const openDock = vi.fn();
    const dock = DockPointer.forFile('/project/src/main.ts', {
      line: 12,
      column: 4,
    })
      .withOption('journeyId', 'journey-1')
      .withOption('sideWindows', 'context,revisions');

    renderButton(
      <DiscussInVibeButton
        dock={dock}
        navigation={{ openDock }}
      />,
    );
    fireEvent.click(screen.getByTestId('asset-discuss-in-vibe'));

    expect(openDock).toHaveBeenCalledTimes(1);
    const destination = openDock.mock.calls[0][0] as DockPointer;
    expect(destination.viewMode).toBe(ViewMode.Vibe);
    expect(destination.viewType).toBe(dock.viewType);
    expect(destination.pointer).toBe(dock.pointer);
    expect(destination.layout).toBe(dock.layout);
    expect(destination.page).toBe(dock.page);
    expect(destination.options).toEqual({
      ...dock.options,
      viewMode: ViewMode.Vibe,
    });
  });

  it('renders as a compact icon-only action with an accessible tooltip label', () => {
    renderButton(
      <DiscussInVibeButton
        dock={DockPointer.forFile('/project/note.md')}
        navigation={{ openDock: vi.fn() }}
      />,
    );

    const button = screen.getByTestId('asset-discuss-in-vibe');
    expect(button.getAttribute('aria-label')).toBe('Discuss');
    expect(button.classList.contains('h-7')).toBe(true);
    expect(button.classList.contains('w-7')).toBe(true);
    expect(button.textContent).toBe('');
  });

  it('leaves the projectless seam disabled without navigating', () => {
    const openDock = vi.fn();
    renderButton(
      <DiscussInVibeButton
        dock={DockPointer.forFile('/tmp/note.txt')}
        navigation={{ openDock }}
        disabled
      />,
    );

    fireEvent.click(screen.getByTestId('asset-discuss-in-vibe'));
    expect(openDock).not.toHaveBeenCalled();
  });
});
