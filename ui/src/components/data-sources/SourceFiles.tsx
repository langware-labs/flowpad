import { useCallback, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { type DataSource, VFSPath } from '@sdk';
import { SimpleFileManager } from '@src/components/simple-file-manager';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { openSourceFiles } from './data-sources-pointer';

/**
 * A file source's files — the main view of its page: the folder it places them in (a `copy` source's local
 * copy), else its own tree (`DataSource.files_root`, derived by the backend). URL-first: the folder browsed
 * into is the address (`<id>/files/<rel…>`), and nothing above the source's own folder is reachable from
 * here. A file opens via `navigation.openFile`, like the Explorer.
 */
export function SourceFiles({ source, rel }: { source: DataSource; rel: string | null }) {
  const { navigation } = useDockNavigation();
  const top = source.files_root ? VFSPath.fromMachinePath(source.files_root, LOCAL_COMPUTE_NODE).machinePath : null;
  // Bumped to remount the manager back at the top when it was walked above it (its own state moved, the URL did not).
  const [epoch, setEpoch] = useState(0);

  const onPathChange = useCallback(
    (path: string) => {
      if (!top) return;
      const browsed = VFSPath.parse(path).machinePath || path;
      // Above the source's folder is not this source's: stay at its top.
      if (browsed !== top && !browsed.startsWith(`${top}/`)) {
        setEpoch((n) => n + 1);
        openSourceFiles(navigation, source.id, '');
        return;
      }
      openSourceFiles(navigation, source.id, browsed.slice(top.length).replace(/^\/+/, ''));
    },
    [navigation, source.id, top],
  );

  if (!top) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <FolderOpen className="size-4" />
        <Trans>This source has no folder on this machine yet.</Trans>
      </p>
    );
  }
  return (
    <div
      className="min-h-[24rem] flex-1 overflow-hidden rounded-lg border border-border"
      data-testid={`source-files-${source.id}`}
    >
      <SimpleFileManager
        key={epoch}
        typeId={LOCAL_COMPUTE_NODE}
        initialPath={rel ? `${top}/${rel}` : top}
        onPathChange={onPathChange}
        onFileSelect={(file) => navigation.openFile(file)}
        className="h-full"
      />
    </div>
  );
}
