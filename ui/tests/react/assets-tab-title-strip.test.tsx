/**
 * React render: the assets tab chip in the REAL strip is titled by SCOPE —
 * "<project>'s Assets" / "My Assets" / "Assets" (global, via the registry
 * fallback). Same harness as conversation-tab-opens: a real `TabRow` whose
 * `name = dataManager.getTabName(dock)`, fed through the real
 * `useTabStripItems` → `<TabStrip>`. No mocks of the strip or label resolution.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { dataManager, Tab } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ALL_SCOPE_FILTER, type ScopeFilter } from '@src/lib/scope-filter';
import { TabStrip } from '@src/components/tabs/TabStrip';
import { useTabStripItems } from '@src/tabs/tab-row-item';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';

function Strip({ tabs }: { tabs: Tab[] }) {
  const items = useTabStripItems(tabs);
  return <TabStrip items={items} activeKey="" onSelect={() => {}} onClose={() => {}} />;
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

describe('assets tab chip title follows scope', () => {
  it('project scope → "<project>\'s Assets"', () => {
    dataManager.updateEntityFromJson({ type: 'project', id: PROJECT_ID, name: 'Acme' });
    render(<Strip tabs={[tabFor({ user: false, projects: [PROJECT_ID] })]} />);
    expect(screen.getByText("Acme's Assets")).toBeInTheDocument();
  });

  it('user scope → "My Assets"', () => {
    render(<Strip tabs={[tabFor({ user: true, projects: [] })]} />);
    expect(screen.getByText('My Assets')).toBeInTheDocument();
  });

  it('global scope → "Assets" (registry fallback)', () => {
    render(<Strip tabs={[tabFor(ALL_SCOPE_FILTER)]} />);
    expect(screen.getByText('Assets')).toBeInTheDocument();
  });
});
