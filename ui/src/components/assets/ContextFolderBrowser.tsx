import { FolderOpen } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { Trans } from '@lingui/react/macro';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useExplorerComputeNode } from '@src/components/explorer-view/useExplorerComputeNode';
import { normalizeRel } from '@src/components/browseable-tree/adapters/fsFolderRoot';
import { SimpleFileManager } from '@src/components/simple-file-manager';

interface ContextFolderBrowserProps {
  /** Compute-node-relative path (no leading slash) from the `fs/` pointer. */
  relPath: string;
  /** Host navigation (AssetsPage's `navigateAsset`) — re-stamps the active
   *  scope so folder navigation stays in the same assets/project tab. */
  onNavigate: (p: DockPointer) => void;
}

/**
 * ContextFolderBrowser — the Assets body for an `fs/<relPath>` pointer: a real
 * file explorer (the Explorer's `SimpleFileManager`) anchored at a project
 * context folder. URL-first: navigating into a subfolder rewrites the pointer;
 * double-clicking a file dispatches through `navigation.openFile`.
 */
export function ContextFolderBrowser({ relPath, onNavigate }: ContextFolderBrowserProps) {
  const { navigation } = useDockNavigation();
  const { typeId } = useExplorerComputeNode();

  const initialPath = useMemo(() => {
    const rel = normalizeRel(relPath);
    return rel ? `/${rel}` : '/';
  }, [relPath]);

  const handlePathChange = useCallback(
    (path: string) => {
      onNavigate(DockPointer.forAssetFsFolder(path));
    },
    [onNavigate],
  );

  const handleFileSelect = useCallback(
    (path: string) => {
      // Extension dispatch (md → assets document viewer, else code editor)
      // lives in openFile — mirror the Explorer body.
      navigation.openFile(path);
    },
    [navigation],
  );

  if (!typeId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <FolderOpen className="h-12 w-12 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground"><Trans>No compute node available</Trans></p>
      </div>
    );
  }

  return (
    <SimpleFileManager
      typeId={typeId}
      initialPath={initialPath}
      onPathChange={handlePathChange}
      onFileSelect={handleFileSelect}
      className="h-full"
    />
  );
}
