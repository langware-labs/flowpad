import { VFSPath } from '@sdk';
import { Trans } from '@lingui/react/macro';
import { memo, useMemo } from 'react';
import { useExplorerComputeNode } from '@src/components/explorer-view/useExplorerComputeNode';
import { isPathInside } from '@src/components/terminal/project-list-menu';
import { SimpleDirTree } from '@src/components/terminal/interactive-terminal/side-windows/SimpleDirTree';

interface EditorFileTreeProps {
  /** The editor's active file (`compute_node-@local/<abs path>`). */
  activePath?: string | null;
  /** A file row was picked; the path is in the same locator form as `activePath`. */
  onOpenFile: (path: string) => void;
}

/**
 * EditorFileTree — the code editor's side directory browser: the terminal's
 * `SimpleDirTree`, opened on the active file's folder and bounded by the
 * project (or, outside any project, by the machine root). Memoized: the editor
 * re-renders on every streamed content chunk, the listing need not.
 */
export const EditorFileTree = memo(function EditorFileTree({ activePath, onOpenFile }: EditorFileTreeProps) {
  const { typeId, locatorTypeId, projectRootPath } = useExplorerComputeNode();

  const parsed = useMemo(() => VFSPath.parse(activePath), [activePath]);
  // The browser only lists the compute node it knows; a file addressed through
  // another entity (a project fs path, a remote node) gets no tree.
  const onThisNode = !!(parsed.typeId && locatorTypeId && parsed.typeId.equals(locatorTypeId));
  const filePath = onThisNode ? parsed.machinePath : null;
  const projectRoot = projectRootPath ? `/${projectRootPath}` : null;
  const topLevel = filePath ? (projectRoot && isPathInside(filePath, projectRoot) ? projectRoot : '/') : null;

  if (!typeId || !locatorTypeId || !topLevel) {
    return (
      <div className="flex h-full items-center justify-center border-s p-4 text-center text-xs text-muted-foreground">
        <Trans>No file tree for this location</Trans>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden border-s bg-muted/10">
      {/* Keyed on the top level: SimpleDirTree reads `initialPath` only on mount,
          so re-root it when the file moves between the project and elsewhere. */}
      <SimpleDirTree
        key={topLevel}
        computeNodeTypeId={typeId}
        locatorTypeId={locatorTypeId}
        topLevel={topLevel}
        initialPath={parsed.parent.machinePath}
        onSelectFile={onOpenFile}
      />
    </div>
  );
});
