import { FileText } from 'lucide-react';
import { useMemo } from 'react';
import { useAssetSearch } from '@src/hooks/use-asset-search';
import type { AssetFilter } from '@src/components/assets/assetFilter';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';

interface Props {
  projectId: string | null;
}

export function DocsCategory({ projectId }: Props) {
  const { navigation } = useDockNavigation();

  const filter = useMemo<AssetFilter>(
    () => ({
      query: '',
      scope: 'project',
      projectIds: projectId ? [projectId] : [],
      tags: [],
      filters: {},
    }),
    [projectId],
  );

  const { results, isLoading } = useAssetSearch({
    recordType: projectId ? 'markdown' : null,
    filter,
    page: 1,
    pageSize: 20,
  });

  if (!projectId) {
    return <div className="px-2 py-1.5 text-xs italic text-muted-foreground">No project linked</div>;
  }

  if (isLoading && results.length === 0) {
    return <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>;
  }

  if (results.length === 0) {
    return <div className="px-2 py-1.5 text-xs italic text-muted-foreground">No docs shared</div>;
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {results.map((d) => (
        <li
          key={d.record_id}
          onClick={() => navigation.openDock(DockPointer.forAssetEditor('markdown', d.source_path))}
          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <FileText className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate">{d.name}</span>
        </li>
      ))}
    </ul>
  );
}
