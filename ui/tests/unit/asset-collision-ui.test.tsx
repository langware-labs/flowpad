import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { memo, type ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIEntity } from '@sdk';
import {
  AssetCollisionBadge,
  AssetCollisionPanel,
  AssetCollisionProvider,
  AssetCollisionShell,
  assetCollisionWindowId,
  useAssetCollisionEntity,
  useAssetCollisionSideTab,
} from '@src/components/assets/editor/AssetCollisionUI';
import { AssetEditorHeader } from '@src/components/assets/editor/AssetEditorHeader';

const sideWindows = vi.hoisted(() => ({
  windows: [] as string[],
  active: null as string | null,
  open: vi.fn(),
  close: vi.fn(),
  closeAll: vi.fn(),
  select: vi.fn(),
  toggle: vi.fn(),
}));

vi.mock('@src/navigation/useSideWindows', () => ({
  useSideWindows: () => sideWindows,
}));

vi.mock('@src/components/view-mode', () => ({
  useIsAdvanced: () => false,
}));

/**
 * The panel carries a `WikiLabel` ("Learn about duplicates") whose open path
 * goes through react-router, and every surface that hosts the panel is mounted
 * under the app router — so the tests mount it the same way.
 */
function renderRouted(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

let nextEntity = 0;

function entity(duplicateCount = 2) {
  nextEntity += 1;
  return new APIEntity({
    id: `aaaaaaaa-bbbb-4ccc-8ddd-${nextEntity.toString(16).padStart(12, '0')}`,
    asset_ref: '/repo/primary.md',
    duplicate_count: duplicateCount,
    asset_occurrences: [
      { path: '/repo/primary.md', first_seen_at: '2026-07-18T09:00:00Z' },
      { path: '/repo/copy-b.md', first_seen_at: '2026-07-20T09:00:00Z' },
      { path: '/repo/copy-a.md', first_seen_at: '2026-07-19T09:00:00Z' },
    ],
  });
}

function TabProbe() {
  const tab = useAssetCollisionSideTab();
  return tab ? (
    <div data-testid="collision-tab" data-id={tab.id} data-basic={String(tab.availableInNonAdvanced)}>
      {tab.label}
    </div>
  ) : null;
}

const ProjectionProbe = memo(function ProjectionProbe() {
  const item = useAssetCollisionEntity();
  return (
    <div data-testid="projection-probe">
      {item?.duplicate_count}:{item?.asset_occurrences?.map((occurrence) => occurrence.path).join(',')}
    </div>
  );
});

describe('asset collision frontend projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sideWindows.windows = [];
    sideWindows.active = null;
  });

  afterEach(cleanup);

  it('mirrors count visibility and opens only the entity-scoped URL window', () => {
    const item = entity();
    render(
      <AssetCollisionProvider entity={item}>
        <AssetCollisionBadge />
      </AssetCollisionProvider>,
    );

    const badge = screen.getByTestId('asset-collision-warning');
    expect(badge.getAttribute('aria-label')).toBe('This file exists in 3 places — 2 ignored copies');
    fireEvent.click(badge);
    expect(sideWindows.open).toHaveBeenCalledOnce();
    expect(sideWindows.open).toHaveBeenCalledWith(assetCollisionWindowId(item));
    expect(sideWindows.close).not.toHaveBeenCalled();
  });

  it('hides the warning and Markdown tab when the backend count is zero', () => {
    render(
      <AssetCollisionProvider entity={entity(0)}>
        <AssetCollisionBadge />
        <TabProbe />
      </AssetCollisionProvider>,
    );
    expect(screen.queryByTestId('asset-collision-warning')).toBeNull();
    expect(screen.queryByTestId('collision-tab')).toBeNull();
  });

  it('labels the backend-ranked primary first and preserves duplicate order', () => {
    const view = renderRouted(<AssetCollisionPanel entity={entity()} />);
    const panel = within(view.container);
    // The shared `/repo/` head is elided into the common-path line, so rows
    // carry only the segment that actually differs.
    expect(panel.getByTestId('asset-collision-row-primary').textContent).toContain('primary.md');
    const duplicates = panel.getAllByTestId('asset-collision-row-duplicate');
    expect(duplicates.map((row) => row.textContent?.match(/copy-[ab]\.md/)?.[0])).toEqual([
      'copy-b.md',
      'copy-a.md',
    ]);
    // The panel reports; it never acts. The only control is the wiki link —
    // no fork/delete/exclude verbs may appear here.
    expect(panel.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Learn about duplicates',
    ]);
  });

  it('renders the evidence that ranked each occurrence, and the primary basis', () => {
    const item = new APIEntity({
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff',
      asset_ref: '/repo/primary.md',
      duplicate_count: 1,
      asset_occurrences: [
        {
          path: '/repo/src/primary.md',
          first_seen_at: '2026-07-18T09:00:00Z',
          introduced_at: '2026-03-14T10:00:00Z',
          birth_time: '2026-03-14T09:59:00Z',
          rank_basis: 'git',
        },
        {
          path: '/repo/.venv/lib/site-packages/primary.md',
          first_seen_at: '2026-07-20T09:00:00Z',
          birth_time: '2026-07-19T08:00:00Z',
          origin: 'installed_package',
        },
      ],
    });
    const panel = within(renderRouted(<AssetCollisionPanel entity={item} />).container);

    expect(panel.getByTestId('asset-collision-basis').textContent).toContain('oldest in Git history');

    const primary = panel.getByTestId('asset-collision-row-primary').textContent ?? '';
    expect(primary).toContain('Live');
    expect(primary).toContain('2026-03-14 10:00 UTC');
    expect(primary).toContain('A file in your workspace');

    const duplicate = panel.getByTestId('asset-collision-row-duplicate').textContent ?? '';
    expect(duplicate).toContain('Ignored');
    expect(duplicate).toContain('Inside an installed package');
    // No Git evidence for the vendored copy — the row must omit the fact
    // rather than render an empty or placeholder date.
    expect(duplicate).not.toContain('In Git since');
  });

  it('omits evidence rows entirely when the backend sent none', () => {
    const panel = within(renderRouted(<AssetCollisionPanel entity={entity()} />).container);
    const primary = panel.getByTestId('asset-collision-row-primary').textContent ?? '';
    expect(primary).not.toContain('In Git since');
    expect(primary).not.toContain('Created');
    expect(primary).toContain('First indexed');
    expect(panel.queryByTestId('asset-collision-basis')).toBeNull();
  });

  it('registers an always-visible Markdown tab with the entity-scoped id', () => {
    const item = entity(1);
    render(
      <AssetCollisionProvider entity={item}>
        <TabProbe />
      </AssetCollisionProvider>,
    );
    const tab = screen.getByTestId('collision-tab');
    expect(tab.getAttribute('data-id')).toBe(assetCollisionWindowId(item));
    expect(tab.getAttribute('data-basic')).toBe('true');
    expect(tab.textContent).toBe('Duplicates 1');
  });

  it('uses one generic drawer and closes it through URL state', () => {
    const item = entity(1);
    const id = assetCollisionWindowId(item);
    sideWindows.windows = [id];
    renderRouted(
      <AssetCollisionShell entity={item}>
        <div>editor body</div>
      </AssetCollisionShell>,
    );
    const drawer = screen.getByTestId('asset-collision-side-window');
    expect(within(drawer).getAllByTestId('asset-collision-panel')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('asset-collision-side-window-close'));
    expect(sideWindows.close).toHaveBeenCalledWith(id);
  });

  it('surfaces the reusable warning in the shared asset header', () => {
    render(
      <AssetCollisionProvider entity={entity(1)}>
        <AssetEditorHeader fileName="primary.md" dirPath="/repo" />
      </AssetCollisionProvider>,
    );
    expect(screen.getByTestId('asset-collision-warning')).toBeTruthy();
  });

  it('invalidates cached consumers when an APIEntity projection mutates in place', () => {
    const item = entity(2);
    const view = render(
      <AssetCollisionProvider entity={item}>
        <ProjectionProbe />
      </AssetCollisionProvider>,
    );
    expect(screen.getByTestId('projection-probe').textContent).toContain('/repo/copy-b.md');

    item.duplicate_count = 1;
    item.asset_occurrences = item.asset_occurrences?.slice(0, 2);
    view.rerender(
      <AssetCollisionProvider entity={item}>
        <ProjectionProbe />
      </AssetCollisionProvider>,
    );

    expect(screen.getByTestId('projection-probe').textContent).toBe(
      '1:/repo/primary.md,/repo/copy-b.md',
    );
  });
});
