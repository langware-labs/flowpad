import { t } from '@lingui/core/macro';
import { ActionInfo, AgenticProcess, FSEntry, TypeId } from '@sdk';
import { NavigatorPanel } from '@src/components/navigator-panel/NavigatorPanel';
import type { NavigatorDescriptor } from '@src/components/navigator-panel/types';
import { flatEntityRoots } from '@src/components/browseable-tree/adapters/flatEntityRoot';
import { useAction } from '@src/hooks/use-action';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { FileText, RefreshCw } from 'lucide-react';
import { useMemo } from 'react';
import { useParams } from 'react-router';

/**
 * Docs left-menu — the navigator (Zone B). Flat list of `.md` files under
 * `docs/`, URL-first via `DockPointer.forDocs(path)`. The body (`DocsViewer`)
 * renders the active file's content.
 */
export function DocsNavigator() {
  const { processId } = useParams();
  // No process in the URL → no docs folder to browse. Guard the TypeId ctor,
  // which throws "Invalid typeId" on an undefined id (would crash the shell
  // since this navigator mounts at the page root).
  const flowTypeId = useMemo(() => (processId ? new TypeId(AgenticProcess.type, processId) : null), [processId]);
  const { navigation, currentDock } = useDockNavigation();

  const browseDocsActionInfo = useMemo(() => {
    if (!flowTypeId) return null;
    const actionInfo = new ActionInfo('fs', flowTypeId.type, flowTypeId.id, 'GET');
    actionInfo.subpath = ['browse', 'docs'];
    return actionInfo;
  }, [flowTypeId]);

  const {
    data: docsItems,
    isLoading,
    error,
    refetch,
  } = useAction<Required<Pick<FSEntry, 'vfs_abs_path' | 'display_name' | 'is_dir'>>[]>(browseDocsActionInfo, {
    retry: false,
  });

  const roots = useMemo(() => {
    const files = (docsItems ?? [])
      .filter((item) => !item.is_dir && item.display_name.endsWith('.md'))
      .map((item) => ({ path: `docs/${item.display_name}`, name: item.display_name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return flatEntityRoots(
      files.map((f) => ({
        id: f.path,
        label: f.name.replace(/\.md$/, ''),
        pointer: DockPointer.forDocs(f.path),
        icon: <FileText className="h-3.5 w-3.5 text-muted-foreground" />,
      })),
    );
  }, [docsItems]);

  const descriptor: NavigatorDescriptor = useMemo(
    () => ({
      id: 'docs',
      roots,
      isLoading,
      search: { recordTypes: ['markdown'], placeholder: t`Search docs…` },
      header: {
        title: t`Documentation`,
        toolbar: [
          {
            id: 'refresh',
            icon: <RefreshCw />,
            label: t`Refresh docs`,
            run: () => void refetch(),
          },
        ],
      },
      activePointer: currentDock ?? null,
      onNavigate: (p) => navigation.openDock(p),
      emptyState: (
        <div className="text-center">
          <FileText className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-2 text-xs text-muted-foreground">{error ? 'Docs folder not found' : 'No docs'}</p>
        </div>
      ),
    }),
    [roots, isLoading, error, currentDock, navigation, refetch],
  );

  if (!flowTypeId) return null;
  return <NavigatorPanel descriptor={descriptor} />;
}
