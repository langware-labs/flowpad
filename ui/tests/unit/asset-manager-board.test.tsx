/**
 * The Assets board: one list, one toggle per place assets come from.
 *
 * The toggles (Project / Dirs / User / Assistant / <worker>) replaced the old
 * "Assistant" chip and its drill-down. Their source→scope table is shared with
 * the backend through tests/fixtures/asset_board_scopes.json; the backend side
 * (tests/unit/test_asset_board_scopes.py) builds each source for real on disk.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetDescriptor, AssetSource } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';
import type { AssetManagerPopoverProps } from '@src/components/asset-manager/AssetManagerPopover';
import { assetBoardScope, BOARD_SCOPES, DEFAULT_SHOWN_SCOPES } from '@src/components/asset-manager/board-scope';
import contract from '../../../tests/fixtures/asset_board_scopes.json';

// The host always supplies its list here; the popover's own staging fetch stays idle.
vi.mock('@src/components/asset-manager/useProcessAssets', () => ({
  useProcessAssets: () => ({ descriptors: [], isLoading: false, refresh: () => Promise.resolve() }),
}));

const { AssetManagerPopover } = await import('@src/components/asset-manager/AssetManagerPopover');

const id = (n: number) => `skill-${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const row = (n: number, source: AssetSource, path: string): AssetDescriptor =>
  ({ typeid: id(n), source, posix_path: path }) as AssetDescriptor;

/** One run's world: 2 project, 1 dirs, 3 user, 1 assistant, 1 worker extra. */
const WORLD: AssetDescriptor[] = [
  row(1, 'project_dir', '/proj/.claude/skills/a/SKILL.md'),
  row(2, 'embedded', '/proc/assets/.claude/skills/b/SKILL.md'),
  row(3, 'additional_dir', '/extra/.claude/skills/c/SKILL.md'),
  row(4, 'user_dir', '/home/me/.claude/skills/d/SKILL.md'),
  row(5, 'user_dir', '/home/me/.claude/skills/e/SKILL.md'),
  row(6, 'user_dir', '/home/me/.claude/skills/f/SKILL.md'),
  row(7, 'system', '/pkg/assistant/.claude/skills/decker/SKILL.md'),
  row(8, 'external', '/home/me/.claude/plugins/cache/acme/skills/lint/SKILL.md'),
];
const assets = (descriptors: AssetDescriptor[], extra: object = {}) => ({
  descriptors,
  isLoading: false,
  refresh: () => Promise.resolve(),
  ...extra,
});
const rowOf = (d: AssetDescriptor) => `asset-manager-row-${d.typeid}-${d.source}`;
const toggle = (scope: string) => screen.queryByTestId(`asset-scope-toggle-${scope}`);

function renderBoard(props: Partial<AssetManagerPopoverProps> = {}) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <AssetManagerPopover open onOpenChange={vi.fn()} centered assets={assets(WORLD)} {...props} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('source → scope contract (shared with the backend)', () => {
  it('maps every backend source to the scope the fixture names', () => {
    for (const [source, scope] of Object.entries(contract.by_source)) {
      expect(assetBoardScope({ source: source as AssetSource }), source).toBe(scope);
    }
    expect([...BOARD_SCOPES]).toEqual(contract.scopes);
    expect([...DEFAULT_SHOWN_SCOPES]).toEqual(contract.default_shown);
  });

  it('files an unknown source from a newer backend with the worker extras, not nowhere', () => {
    expect(assetBoardScope({ source: 'future_source' as AssetSource })).toBe('worker');
  });
});

describe('scope toggles', () => {
  it('show a count per scope and only for scopes that have assets', () => {
    renderBoard({ assets: assets(WORLD.filter((d) => d.source !== 'system')) });
    expect(screen.getByTestId('asset-scope-count-project')).toHaveTextContent('2');
    expect(screen.getByTestId('asset-scope-count-dirs')).toHaveTextContent('1');
    expect(screen.getByTestId('asset-scope-count-user')).toHaveTextContent('3');
    expect(screen.getByTestId('asset-scope-count-worker')).toHaveTextContent('1');
    expect(toggle('assistant')).toBeNull();
  });

  it('start with Project + Dirs on and the rest off', () => {
    renderBoard();
    expect(toggle('project')).toHaveAttribute('aria-pressed', 'true');
    expect(toggle('dirs')).toHaveAttribute('aria-pressed', 'true');
    for (const off of ['user', 'assistant', 'worker']) expect(toggle(off)).toHaveAttribute('aria-pressed', 'false');
    for (const d of WORLD) {
      const shown = ['project_dir', 'embedded', 'additional_dir'].includes(d.source);
      expect(screen.queryByTestId(rowOf(d)) !== null, d.source).toBe(shown);
    }
  });

  it('turn a scope on and off', () => {
    renderBoard();
    fireEvent.click(toggle('user')!);
    WORLD.filter((d) => d.source === 'user_dir').forEach((d) => expect(screen.getByTestId(rowOf(d))).toBeInTheDocument());
    fireEvent.click(toggle('assistant')!);
    expect(screen.getByTestId(rowOf(WORLD[6]))).toBeInTheDocument();
    fireEvent.click(toggle('project')!);
    expect(screen.queryByTestId(rowOf(WORLD[0]))).toBeNull();
    fireEvent.click(toggle('user')!);
    expect(screen.queryByTestId(rowOf(WORLD[3]))).toBeNull();
  });

  it('remember the choice across opens', () => {
    renderBoard();
    fireEvent.click(toggle('user')!);
    cleanup();
    renderBoard();
    expect(toggle('user')).toHaveAttribute('aria-pressed', 'true');
  });

  it('keep their counts while the filter box narrows the rows', () => {
    renderBoard();
    fireEvent.change(screen.getByTestId('asset-manager-list-filter'), { target: { value: 'no-such-asset' } });
    expect(screen.getByTestId('asset-scope-count-user')).toHaveTextContent('3');
  });

  it('say what to do when every scope with assets is off', () => {
    renderBoard({ assets: assets(WORLD.filter((d) => d.source === 'user_dir')) });
    expect(screen.getByText('Turn on a scope above to see its assets.')).toBeInTheDocument();
  });

  it('name the worker toggle after the run’s worker', () => {
    renderBoard({ workerType: 'codex' });
    expect(toggle('worker')).toHaveTextContent('Codex');
  });

  it('replace the old Assistant chip and drill-down', () => {
    renderBoard({ assistantEnabled: true, onToggleAssistant: vi.fn() });
    expect(screen.queryByTestId('asset-manager-assistant-toggle')).toBeNull();
    expect(screen.queryByTestId('asset-manager-flowpad-location')).toBeNull();
  });
});

describe('mounting the Flowpad Assistant from the "+" menu', () => {
  const openMenu = () => fireEvent.keyDown(screen.getByTestId('asset-manager-add-menu'), { key: 'Enter' });

  it('mounts when unmounted', async () => {
    const onToggleAssistant = vi.fn();
    renderBoard({ assistantEnabled: false, onToggleAssistant });
    openMenu();
    const item = await screen.findByTestId('asset-manager-assistant-mount');
    expect(item).toHaveTextContent('Mount Flowpad Assistant');
    fireEvent.click(item);
    expect(onToggleAssistant).toHaveBeenCalledTimes(1);
  });

  it('offers to unmount when mounted', async () => {
    renderBoard({ assistantEnabled: true, onToggleAssistant: vi.fn() });
    openMenu();
    expect(await screen.findByTestId('asset-manager-assistant-mount')).toHaveTextContent('Unmount Flowpad Assistant');
  });

  it('is absent where the host cannot mount (pick surfaces)', () => {
    renderBoard();
    expect(screen.queryByTestId('asset-manager-add-menu')).toBeNull();
  });
});

describe('asset evidence presentation', () => {
  const own = WORLD[0];

  it('renders unresolved historical usage alongside verification failure', () => {
    renderBoard({ assets: assets([], { workerScoped: true, error: true,
      unresolvedUsage: [{ asset: null, reference: 'plugin:deleted', resolution: 'missing', evidence: [{ kind: 'skill_invoked' }] }],
    }) });
    expect(screen.getByTestId('asset-unresolved-usage')).toHaveTextContent('plugin:deleted');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('retains catalog rows without claiming failed worker verification as availability', () => {
    renderBoard({ assets: assets([{ ...own, available: false, present: true }], { workerScoped: true, error: true }) });
    expect(screen.getByTestId('asset-manager-section-other')).toHaveTextContent('Other assets');
    expect(screen.getByTestId(rowOf(own))).toBeInTheDocument();
    expect(screen.queryByTestId('asset-manager-section-available')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not verify available assets');
  });

  it('labels only positively verified unused assets as available', () => {
    renderBoard({ assets: assets([{ ...own, available: true }, row(9, 'workdir', '/not-verified')], { workerScoped: true }) });
    expect(screen.getByTestId('asset-manager-section-available')).toHaveTextContent('Available assets');
    expect(screen.getByTestId('asset-manager-section-other')).toHaveTextContent('Other assets');
  });

  it('keeps an attached-only asset separate from observed usage', () => {
    renderBoard({ assets: assets([
      { ...own, attached: true, usage: [] },
      { ...row(9, 'workdir', '/used'), usage: [{ kind: 'skill_invoked' }] } as AssetDescriptor,
    ], { workerScoped: true }) });
    expect(screen.getByTestId('asset-manager-section-selected')).toHaveTextContent('Attached assets');
    expect(screen.getByTestId('asset-manager-section-used')).toHaveTextContent('Used assets');
  });

  it('shows an inventory failure instead of reporting an empty available list', () => {
    renderBoard({ assets: assets([], { workerScoped: true, error: true }) });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not verify available assets');
    expect(screen.queryByText('No assets available.')).toBeNull();
  });

  it('offers select and improve on pick surfaces', () => {
    renderBoard({ onPick: vi.fn(), onUnpick: vi.fn(), canImprove: () => true, onImprove: vi.fn() });
    const r = screen.getByTestId(rowOf(own));
    expect(within(r).getByTestId(`asset-manager-select-${own.typeid}-${own.source}`)).toBeInTheDocument();
  });
});
