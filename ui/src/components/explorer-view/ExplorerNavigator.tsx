import { t } from '@lingui/core/macro';
import { useMemo } from 'react';
import { Layers, User as UserIcon } from 'lucide-react';
import { NavigatorPanel } from '@src/components/navigator-panel/NavigatorPanel';
import type { NavigatorDescriptor } from '@src/components/navigator-panel/types';
import { ScopeBar, type ScopeBarOption } from '@src/components/ui/scope-bar';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { useExplorerModel, type ExplorerScopeMode } from './useExplorerModel';

/**
 * Explorer left-menu — the navigator (Zone B). A single real-filesystem tree
 * (`fsFolderRoot`) plus a three-mode scope bar (All / User / Project) that
 * selects which root the tree anchors at. All state lives in `useExplorerModel`;
 * the body (`ExplorerView`) is the table, driven by the same URL.
 */
export function ExplorerNavigator() {
  const m = useExplorerModel();

  // Per the type-icon rule, the Project scope icon comes from the type registry.
  const ProjectIcon = useMemo(() => iconForType('project'), []);
  const options = useMemo<ScopeBarOption<ExplorerScopeMode>[]>(
    () => [
      { value: 'all', label: t`All`, icon: Layers, title: t`Whole computer` },
      { value: 'user', label: t`User`, icon: UserIcon, title: t`User home folder` },
      {
        value: 'project',
        label: t`Project`,
        icon: ProjectIcon,
        disabled: m.projectDisabled,
        title: m.projectDisabled ? 'No current project' : `Project${m.projectName ? `: ${m.projectName}` : ''}`,
      },
    ],
    [ProjectIcon, m.projectDisabled, m.projectName],
  );

  // Not memoized: `useExplorerModel` returns a fresh object each render; the
  // panel rebuilds the tree each render and BrowseableTree memoizes itself.
  const descriptor: NavigatorDescriptor = {
    id: 'explorer',
    roots: m.roots,
    activePointer: m.activePointer,
    onNavigate: m.navigate,
    search: { recordTypes: ['markdown'], placeholder: t`Search files…` },
    header: {
      title: t`Files`,
      filterBar: <ScopeBar variant="icon" value={m.scopeMode} options={options} onChange={m.handleSelectMode} />,
    },
  };

  return <NavigatorPanel descriptor={descriptor} />;
}
