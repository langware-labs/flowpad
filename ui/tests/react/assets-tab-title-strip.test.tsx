/**
 * React render: an INACTIVE assets tab chip in the REAL strip is titled by SCOPE
 * — "<project>'s Assets" / "My Assets" / "Assets" (global, via the registry
 * fallback). Same harness as conversation-tab-opens: a real `TabRow` whose
 * `name = dataManager.getTabName(dock)`, fed through the real `useTabStripItems`
 * → `<TabStrip>`. No mocks of the strip or label resolution. (The ACTIVE assets
 * tab is overlaid with its focused asset's name — `useTabStripItems` reads the
 * current dock; here the router sits at "/" so no assets tab is active.)
 */
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { dataManager, Shell, Tab, TypeId } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import {
  ALL_SCOPE_FILTER,
  projectScope,
  userScope,
  type ScopeFilter,
} from '@src/lib/scope-filter';
import { TabStrip } from '@src/components/tabs/TabStrip';
import { useTabStripItems } from '@src/tabs/tab-row-item';
import { setViewMode, ViewMode } from '@src/contexts/view-mode-context';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
let assetSequence = 0;

function StripInner({ tabs }: { tabs: Tab[] }) {
  const items = useTabStripItems(tabs);
  return <TabStrip items={items} activeKey="" onSelect={() => {}} onClose={() => {}} />;
}

// `useTabStripItems` reads the current dock (useDockNavigation → react-router),
// so the strip must render under a real dock route. "/" → no active assets tab.
function Strip({ tabs, initialEntry = '/' }: { tabs: Tab[]; initialEntry?: string }) {
  return (
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/dock/:viewType/*" element={<StripInner tabs={tabs} />} />
        <Route path="*" element={<StripInner tabs={tabs} />} />
      </Routes>
    </MemoryRouter>
  );
}

// A real Tab entity (not a plain row): the registry "Assets" fallback for the
// null-name global tab relies on the `Tab.dockPointer` getter.
function tabFor(scope: ScopeFilter): Tab {
  const dock = DockPointer.forAssetList('all', { scope });
  return new Tab({
    id: PROJECT_ID,
    pointer: dock.toJSON() ?? '',
    target_type: null,
    target_id: null,
    project_id: null,
    name: dataManager.getTabName(dock),
    visible: true,
  });
}

function contentTab(
  remote?: boolean,
  focusRemote?: boolean,
): { tab: Tab; dock: DockPointer } {
  assetSequence += 1;
  const id = `44444444-4444-4444-8444-${String(assetSequence).padStart(12, '0')}`;
  const typeId = new TypeId('markdown', id);
  const dock = DockPointer.forAssetEditorByTypeId('markdown', typeId)
    .withScopeFilter(ALL_SCOPE_FILTER);
  if (focusRemote !== undefined) {
    dataManager.updateEntityFromJson({
      type: 'markdown',
      id,
      name: `Notes ${assetSequence}`,
      remote: focusRemote,
    });
  }
  return {
    dock,
    tab: new Tab({
      id: `55555555-5555-4555-8555-${String(assetSequence).padStart(12, '0')}`,
      pointer: dock.toJSON() ?? '',
      target_type: 'markdown',
      target_id: id,
      target_remote: remote,
      project_id: null,
      name: `Notes ${assetSequence}`,
      visible: true,
    }),
  };
}

afterEach(() => {
  setViewMode(ViewMode.Standard);
});

describe('assets tab chip title follows scope', () => {
  it('project scope → "<project>\'s Assets"', () => {
    dataManager.updateEntityFromJson({ type: 'project', id: PROJECT_ID, name: 'Acme' });
    render(<Strip tabs={[tabFor(projectScope(PROJECT_ID))]} />);
    expect(screen.getByText("Acme's Assets")).toBeInTheDocument();
  });

  it('user scope → "My Assets"', () => {
    render(<Strip tabs={[tabFor(userScope())]} />);
    expect(screen.getByText('My Assets')).toBeInTheDocument();
  });

  it('global scope → "Assets" (registry fallback)', () => {
    render(<Strip tabs={[tabFor(ALL_SCOPE_FILTER)]} />);
    expect(screen.getByText('Assets')).toBeInTheDocument();
  });

  it('active VFS editor route → filename', () => {
    const dock = DockPointer.forAssetEditor(
      'markdown',
      '/Users/test/project/docs/agent/interface.md',
    ).withScopeFilter(ALL_SCOPE_FILTER);
    const tab = tabFor(ALL_SCOPE_FILTER);

    expect(dock.tabHash).toBe(tab.dockPointer?.tabHash);
    render(<Strip tabs={[tab]} initialEntry={dock.toUrl()} />);

    expect(screen.getByText('interface.md')).toBeInTheDocument();
    expect(screen.queryByText('Assets')).not.toBeInTheDocument();
  });
});

describe('content tab entity location icons', () => {
  it.each([
    [true, 'cloud'],
    [false, 'local'],
    [undefined, 'unknown'],
  ] as const)('renders inactive target_remote=%s as %s', (remote, expected) => {
    const { tab } = contentTab(remote);
    render(<Strip tabs={[tab]} />);

    const chip = screen.getByTestId(`tab-content-${tab.dockPointer?.tabHash}`);
    const icon = chip.querySelector('[data-entity-location]');
    expect(icon).toHaveAttribute('data-entity-location', expected);
    expect(chip).not.toHaveAttribute('aria-label');

    const type = icon?.querySelector('[data-entity-type-icon]');
    expect(type).toBeTruthy();
    expect(icon?.firstElementChild).toBe(
      expected === 'unknown'
        ? type
        : icon?.querySelector('[data-location-glyph]'),
    );
  });

  it.each([
    [true, false, 'local'],
    [false, true, 'cloud'],
    [true, undefined, 'cloud'],
    [undefined, undefined, 'unknown'],
  ] as const)(
    'active focus remote=%s takes precedence over target_remote=%s',
    (targetRemote, focusRemote, expected) => {
      const { tab, dock } = contentTab(targetRemote, focusRemote);
      render(<Strip tabs={[tab]} initialEntry={dock.toUrl()} />);

      const chip = screen.getByTestId(`tab-content-${tab.dockPointer?.tabHash}`);
      expect(chip.querySelector('[data-entity-location]')).toHaveAttribute(
        'data-entity-location',
        expected,
      );
    },
  );

  it('keeps one host tooltip with exact known location copy', async () => {
    setViewMode(ViewMode.Advanced);
    const user = userEvent.setup();
    const { tab } = contentTab(true);
    render(<Strip tabs={[tab]} />);

    const chip = screen.getByTestId(`tab-content-${tab.dockPointer?.tabHash}`);
    await user.hover(chip);

    const tooltip = await screen.findByRole('tooltip');
    expect(within(tooltip).getByTestId('tab-tooltip-location')).toHaveTextContent(
      'Available on cloud',
    );
  });

  it('leaves terminal/provider icons plain', () => {
    const id = '66666666-6666-4666-8666-666666666666';
    const dock = new DockPointer('shell', `${Shell.type}-${id}`);
    const tab = new Tab({
      id: '77777777-7777-4777-8777-777777777777',
      pointer: dock.toJSON() ?? '',
      target_type: Shell.type,
      target_id: id,
      target_remote: true,
      name: 'Terminal',
      visible: true,
    });
    render(<Strip tabs={[tab]} />);

    const chip = screen.getByTestId(`tab-${tab.dockPointer?.tabHash}`);
    expect(chip.querySelector('[data-entity-location]')).toBeNull();
    expect(chip.querySelector('[data-provider]')).toBeTruthy();
  });
});
