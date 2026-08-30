import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { AgenticProcess, FSRef, TypeId } from '@sdk';
import { VfsMarkdownPane } from '@src/components/vfs-markdown-pane';
import { useViewerStore } from '@src/hooks/flow-hooks';
import { FileText } from 'lucide-react';
import { useMemo } from 'react';
import { Trans } from '@lingui/react/macro';

/**
 * Markdown body for the MARKDOWN dock — renders the file the URL's codeRef
 * points at, scoped to the active AgenticProcess's VFS.
 */
export function MarkdownViewer() {
  const { flow } = useAgentContext();
  const { currentContext } = useViewerStore();
  const filePath = currentContext?.codeRef?.path;

  const fsRef = useMemo(
    () => (flow?.id && filePath ? new FSRef(filePath, new TypeId(AgenticProcess.type, flow.id), 'text', true) : null),
    [flow?.id, filePath],
  );

  return (
    <VfsMarkdownPane
      fsRef={fsRef}
      title={filePath}
      emptyState={
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <div className="text-center">
            <FileText className="mx-auto mb-3 h-12 w-12 text-muted-foreground/50" />
            <p className="text-sm font-medium">
              <Trans>No markdown file selected</Trans>
            </p>
          </div>
        </div>
      }
    />
  );
}
