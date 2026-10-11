/**
 * Opening an asset from a form's Attach picker must not leave the form.
 *
 * In the diagnosis-request dialog, clicking a skill's name in the picker opened its editor in this
 * window: the dialog and everything typed into it were gone. A host with unsaved input asks for
 * `openInWindow`, and the asset opens in a new window instead.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetDescriptor } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { NavigationActions } from '@src/navigation/NavigationActions';

vi.mock('@src/components/asset-manager/useProcessAssets', () => ({
  useProcessAssets: () => ({ descriptors: [], isLoading: false, refresh: () => Promise.resolve() }),
}));

const { AssetManagerPopover } = await import('@src/components/asset-manager/AssetManagerPopover');

const SKILL = {
  typeid: 'skill-00000001-1111-4111-8111-111111111111',
  source: 'project_dir',
  posix_path: '/proj/.claude/skills/widget-check/SKILL.md',
} as AssetDescriptor;

function openChip(openInWindow: boolean) {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <AssetManagerPopover
          open
          onOpenChange={vi.fn()}
          centered
          assets={{ descriptors: [SKILL], isLoading: false, refresh: () => Promise.resolve() }}
          onPick={vi.fn()}
          onUnpick={vi.fn()}
          openInWindow={openInWindow}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByTestId(`asset-manager-open-${SKILL.typeid}-${SKILL.source}`));
}

describe('opening an asset from the picker', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('uses a new window when the host holds unsaved input', () => {
    const inPlace = vi.spyOn(NavigationActions.prototype, 'openDock').mockImplementation(() => {});
    const inWindow = vi.spyOn(NavigationActions.prototype, 'openDockInWindow').mockImplementation(() => {});

    openChip(true);

    expect(inWindow).toHaveBeenCalledTimes(1);
    expect(inPlace).not.toHaveBeenCalled();
  });

  it('opens in place everywhere else', () => {
    const inPlace = vi.spyOn(NavigationActions.prototype, 'openDock').mockImplementation(() => {});
    const inWindow = vi.spyOn(NavigationActions.prototype, 'openDockInWindow').mockImplementation(() => {});

    openChip(false);

    expect(inPlace).toHaveBeenCalledTimes(1);
    expect(inWindow).not.toHaveBeenCalled();
  });
});
