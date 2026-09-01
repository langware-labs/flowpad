import { AgenticProcess, FSRef, TypeId, VFSPath } from '@sdk';
import { VfsMarkdownPane } from '@src/components/vfs-markdown-pane';
import { useViewerStore } from '@src/hooks/flow-hooks';
import { FileText } from 'lucide-react';
import { useMemo } from 'react';
import { useParams } from 'react-router';
import { Trans } from '@lingui/react/macro';

/**
 * Docs body — renders the active file's content. The file list moved to the
 * shared left-menu (`DocsNavigator`, Zone B). Active file is URL-derived
 * (`currentContext.codeRef.path` === currentDock.pointer).
 */
export function DocsViewer() {
  const { processId } = useParams();
  const { currentContext } = useViewerStore();
  const activeDocVfsPath = currentContext?.codeRef?.path || null;

  // Guard the TypeId ctor (throws on undefined id) for processId-less docs URLs.
  const fsRef = useMemo(
    () =>
      processId && activeDocVfsPath
        ? new FSRef(activeDocVfsPath, new TypeId(AgenticProcess.type, processId), 'text', true)
        : null,
    [processId, activeDocVfsPath],
  );

  return (
    <VfsMarkdownPane
      fsRef={fsRef}
      title={activeDocVfsPath ? VFSPath.parse(activeDocVfsPath).filename.replace(/\.md$/, '') : undefined}
      subtitle={activeDocVfsPath ?? undefined}
      emptyState={
        <div className="flex h-full flex-1 flex-col bg-background">
          <div className="flex h-[52px] items-center border-b bg-muted/50 px-3">
            <h3 className="text-sm font-medium text-muted-foreground">
              <Trans>No Document Selected</Trans>
            </h3>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
            <FileText className="h-16 w-16 text-muted-foreground/50" />
            <p className="mt-4 text-lg text-muted-foreground">
              <Trans>Select a document</Trans>
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              <Trans>Choose a document from the sidebar to view its contents</Trans>
            </p>
          </div>
        </div>
      }
    />
  );
}
