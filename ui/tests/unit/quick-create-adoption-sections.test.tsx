/**
 * Where the adoption tiles are allowed to appear.
 *
 * `QuickCreateModal` is titled "Create new", and both `folder` and `helpdesk`
 * point the project at something that ALREADY EXISTS — someone else's folder,
 * someone else's support desk. The folder tile taught this the hard way: under
 * a "Create new" heading, users clicked "Project" expecting to make one and got
 * a picker. `helpdesk` is excluded by the same rule.
 *
 * This test exists because that rule is invisible at the call site — nothing
 * stops a later change from putting either section back into the modal, and the
 * damage is a mislabelled affordance rather than a crash.
 */
import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  project: { id: 'p1', name: 'Demo' },
  onAddHelpdesk: vi.fn(),
}));

vi.mock('@sdk/react/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk/react/hooks')>();
  return { ...actual, useProject: () => ({ project: mocks.project }) };
});
vi.mock('@src/hooks/use-asset-types', () => ({
  useAssetTypes: (options: { allUserTypes?: boolean }) => ({
    types: [
      { type_name: 'agent', creatable: true },
      ...(options.allUserTypes ? [{ type_name: 'whiteboard', creatable: true }] : []),
    ],
  }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() } }),
}));

import { TooltipProvider } from '@src/components/ui/tooltip';
import {
  ADOPTION_SECTIONS,
  ALL_SECTIONS,
  QuickCreatePanel,
  type PanelHandlers,
} from '@src/components/quick-create/QuickCreatePanel';

const handlers: PanelHandlers = {
  onPick: vi.fn(),
  onAddFolder: vi.fn(),
  onAddHelpdesk: mocks.onAddHelpdesk,
  onNewMessage: vi.fn(),
  onNewProject: vi.fn(),
  onNewProjectFromGit: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('quick-create adoption sections', () => {
  it('treats folder and helpdesk as adoption, not creation', () => {
    expect([...ADOPTION_SECTIONS].sort()).toEqual(['folder', 'helpdesk']);
    // The modal's filter, spelled the same way it is there.
    const modalSections = ALL_SECTIONS.filter((s) => !ADOPTION_SECTIONS.has(s));
    expect(modalSections).not.toContain('helpdesk');
    expect(modalSections).not.toContain('folder');
    expect(modalSections).toEqual(['chat', 'build', 'write', 'connect', 'project']);
  });

  it('renders the Add help desk tile in the helpdesk section', () => {
    render(
      <TooltipProvider>
        <QuickCreatePanel {...handlers} sections={['helpdesk']} />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('quick-create-add-helpdesk')).toBeInTheDocument();
  });

  it('respects an explicit absent project instead of the active project for adoption', () => {
    render(<TooltipProvider><QuickCreatePanel {...handlers} project={null} sections={['helpdesk']} /></TooltipProvider>);
    expect(screen.getByTestId('quick-create-add-helpdesk')).toHaveAttribute('aria-disabled', 'true');
  });

  it('dismisses the picker before opening the configured source form', () => {
    const calls: string[] = [];
    render(
      <TooltipProvider>
        <QuickCreatePanel {...handlers} sections={['connect']}
          onDone={() => calls.push('dismiss')} onNewDataSource={() => calls.push('source')} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByTestId('quick-create-data-source'));
    expect(calls).toEqual(['dismiss', 'source']);
  });

  it('offers advanced creation types when the host requests all user types', () => {
    const { rerender } = render(<TooltipProvider><QuickCreatePanel {...handlers} sections={['write']} /></TooltipProvider>);
    expect(screen.queryByRole('button', { name: 'Whiteboard', exact: true })).not.toBeInTheDocument();
    rerender(<TooltipProvider><QuickCreatePanel {...handlers} sections={['write']} allUserTypes /></TooltipProvider>);
    expect(screen.getByRole('button', { name: 'Whiteboard', exact: true })).toBeInTheDocument();
  });

  it('places the host Vibe launcher before provider tiles under Launch', () => {
    const start = vi.fn();
    render(
      <TooltipProvider>
        <QuickCreatePanel {...handlers} sections={['chat']} chatTitle="Launch"
          leadingSessionTiles={[{ key: 'vibe', Icon: () => null, label: 'Vibe', wikiword: 'Vibe', onClick: start }]} />
      </TooltipProvider>,
    );
    expect(screen.getByText('Launch')).toBeInTheDocument();
    const vibe = screen.getByRole('button', { name: 'Vibe', exact: true });
    const claude = screen.getByRole('button', { name: 'Claude Code', exact: true });
    expect(vibe.compareDocumentPosition(claude) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(vibe);
    expect(start).toHaveBeenCalledOnce();
  });

  it('disables the tile with no current project — a desk is adopted BY something', () => {
    mocks.project = null as unknown as { id: string; name: string };
    render(
      <TooltipProvider>
        <QuickCreatePanel {...handlers} sections={['helpdesk']} />
      </TooltipProvider>,
    );
    // `aria-disabled`, not the native attribute: a natively disabled button
    // drops pointer events and takes its explanatory tip with it.
    expect(screen.getByTestId('quick-create-add-helpdesk')).toHaveAttribute('aria-disabled', 'true');
    mocks.project = { id: 'p1', name: 'Demo' };
  });
});
