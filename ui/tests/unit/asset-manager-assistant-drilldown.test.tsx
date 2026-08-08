import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetDescriptor } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';
import type { AssetManagerPopoverProps } from '@src/components/asset-manager/AssetManagerPopover';

const h = vi.hoisted(() => {
  const PROCESS_SKILL = 'skill-11111111-1111-4111-8111-111111111111';
  const ASSISTANT_SKILL = 'skill-22222222-2222-4222-8222-222222222222';
  const ASSISTANT_AGENT = 'subagent-33333333-3333-4333-8333-333333333333';
  const USER_NOISE = 'skill-44444444-4444-4444-8444-444444444444';
  return {
    PROCESS_SKILL,
    ASSISTANT_SKILL,
    ASSISTANT_AGENT,
    USER_NOISE,
    projectIds: [] as (string | undefined)[],
    // Built ONCE. The real hook returns state, so its identity is stable across
    // renders; a mock that re-allocates re-triggers the popover's entity
    // prefetch effect every render and the run never settles.
    assistant: [
      { typeid: ASSISTANT_SKILL, source: 'project_dir', posix_path: '/pkg/assistant/.claude/skills/decker/SKILL.md' },
      { typeid: ASSISTANT_AGENT, source: 'project_dir', posix_path: '/pkg/assistant/.claude/agents/vibe.md' },
      // The action's scan-dir policy always includes the user home; those rows
      // are the user's, not the assistant's, and must not show in its list.
      { typeid: USER_NOISE, source: 'user_dir', posix_path: '/home/me/.claude/skills/mine/SKILL.md' },
    ],
    none: [] as unknown[],
  };
});

const { PROCESS_SKILL, ASSISTANT_SKILL, ASSISTANT_AGENT, USER_NOISE } = h;

/**
 * One hook serves both lists; which one it answers with is decided by the
 * `projectId` option — exactly the seam the drill-down relies on.
 */
vi.mock('@src/components/asset-manager/useProcessAssets', () => ({
  useProcessAssets: (_process: unknown, options?: { enabled?: boolean; projectId?: string }) => {
    if (options?.enabled) h.projectIds.push(options?.projectId);
    return {
      descriptors: (options?.enabled && options?.projectId ? h.assistant : h.none) as AssetDescriptor[],
      isLoading: false,
      refresh: () => Promise.resolve(),
    };
  },
}));

const { AssetManagerPopover } = await import('@src/components/asset-manager/AssetManagerPopover');

const processAssets = {
  descriptors: [{ typeid: PROCESS_SKILL, source: 'embedded' as const, posix_path: '/proj/.claude/skills/a/SKILL.md' }],
  isLoading: false,
  refresh: () => Promise.resolve(),
};

function renderManager(props: Partial<AssetManagerPopoverProps> = {}) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <AssetManagerPopover
          open
          onOpenChange={vi.fn()}
          centered
          assets={processAssets}
          assistantEnabled
          onToggleAssistant={vi.fn()}
          {...props}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  h.projectIds = [];
});

describe('Flowpad Assistant drill-down — same modal, same rows, one level down', () => {
  it('descends into the assistant and comes back, without leaving the surface', async () => {
    renderManager();

    // Top level: the process list, with the assistant standing in as one row.
    expect(screen.getByTestId(`asset-manager-row-${PROCESS_SKILL}-embedded`)).toBeInTheDocument();
    expect(screen.getByTestId('asset-manager-breadcrumb')).toHaveTextContent('Assets');
    expect(screen.queryByTestId('asset-manager-crumb-root')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('asset-manager-flowpad-location'));

    // Same dialog — the assistant's assets rendered through the same rows.
    await waitFor(() =>
      expect(screen.getByTestId(`asset-manager-row-${ASSISTANT_SKILL}-project_dir`)).toBeInTheDocument(),
    );
    expect(screen.getByTestId(`asset-manager-row-${ASSISTANT_AGENT}-project_dir`)).toBeInTheDocument();
    // The subject changed, so the process's own rows are gone…
    expect(screen.queryByTestId(`asset-manager-row-${PROCESS_SKILL}-embedded`)).not.toBeInTheDocument();
    // …and so is the row that only came along because the scan reads user home.
    expect(screen.queryByTestId(`asset-manager-row-${USER_NOISE}-user_dir`)).not.toBeInTheDocument();
    // Asked of the assistant project by uname, never of the current subject.
    expect(h.projectIds).toContain('@flowpad_assistant');

    // Breadcrumb names where we are and offers the way back up.
    const crumbs = screen.getByTestId('asset-manager-breadcrumb');
    expect(crumbs).toHaveTextContent('Flowpad Assistant');
    expect(within(crumbs).getByTestId('asset-manager-crumb-root')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('asset-manager-back'));
    await waitFor(() => expect(screen.getByTestId(`asset-manager-row-${PROCESS_SKILL}-embedded`)).toBeInTheDocument());
    expect(screen.getByTestId('asset-manager-flowpad-location')).toBeInTheDocument();
  });

  it('is a read-only board: assistant rows open, they do not attach', async () => {
    renderManager({ onPick: vi.fn(), onUnpick: vi.fn(), canImprove: () => true, onImprove: vi.fn() });

    // The pick surface offers select on its own rows…
    expect(screen.getByTestId(`asset-manager-select-${PROCESS_SKILL}-embedded`)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('asset-manager-flowpad-location'));
    const row = await screen.findByTestId(`asset-manager-row-${ASSISTANT_SKILL}-project_dir`);

    // …but the assistant is mounted wholesale, so its rows carry neither the
    // select nor the improve control — only open and reveal.
    expect(within(row).queryByTestId(`asset-manager-select-${ASSISTANT_SKILL}-project_dir`)).not.toBeInTheDocument();
    expect(within(row).queryByTestId(`asset-manager-improve-${ASSISTANT_SKILL}-project_dir`)).not.toBeInTheDocument();
    expect(within(row).getByTestId(`asset-manager-open-${ASSISTANT_SKILL}-project_dir`)).toBeInTheDocument();
  });

  it('filters within the drill-down and resets the box on the way out', async () => {
    renderManager();
    fireEvent.click(screen.getByTestId('asset-manager-flowpad-location'));
    await screen.findByTestId(`asset-manager-row-${ASSISTANT_SKILL}-project_dir`);

    fireEvent.change(screen.getByTestId('asset-manager-list-filter'), { target: { value: 'vibe' } });
    expect(screen.getByTestId(`asset-manager-row-${ASSISTANT_AGENT}-project_dir`)).toBeInTheDocument();
    expect(screen.queryByTestId(`asset-manager-row-${ASSISTANT_SKILL}-project_dir`)).not.toBeInTheDocument();

    // Going back with a live filter must not land on a list filtered by a term
    // that belonged to the level below.
    fireEvent.click(screen.getByTestId('asset-manager-back'));
    await waitFor(() => expect(screen.getByTestId('asset-manager-list-filter')).toHaveValue(''));
    expect(screen.getByTestId(`asset-manager-row-${PROCESS_SKILL}-embedded`)).toBeInTheDocument();
  });
});
