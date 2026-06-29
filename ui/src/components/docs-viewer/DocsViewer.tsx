import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { ActionInfo, AgenticProcess, dataManager, TypeId, VFSPath } from '@sdk';
import { MarkdownView } from '@src/components/markdown-view';
import { Button } from '@src/components/ui/button';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { useViewerStore } from '@src/hooks/flow-hooks';
import { FileText, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';

/**
 * Docs body — renders the active file's content. The file list moved to the
 * shared left-menu (`DocsNavigator`, Zone B). Active file is URL-derived
 * (`currentContext.codeRef.path` === currentDock.pointer).
 */
export function DocsViewer() {
  const { processId } = useParams();
  // Guard the TypeId ctor (throws on undefined id) for processId-less docs URLs.
  const flowTypeId = useMemo(
    () => (processId ? new TypeId(AgenticProcess.type, processId) : null),
    [processId],
  );
  const { flow } = useAgentContext();
  const { currentContext } = useViewerStore();
  const [fileContent, setFileContent] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const activeDocVfsPath = useMemo(() => currentContext?.codeRef?.path || null, [currentContext]);

  const loadFile = useCallback(() => {
    if (!activeDocVfsPath || !flow || !flowTypeId) {
      setFileContent('');
      setLoading(false);
      return;
    }
    setLoading(true);
    const actionInfo = new ActionInfo('fs', flowTypeId.type, flowTypeId.id, 'GET');
    actionInfo.subpath = ['download', activeDocVfsPath];
    actionInfo.isRawResponse = true;
    actionInfo.responseType = 'blob';

    dataManager
      .callAction<unknown, Blob>(actionInfo)
      .then(async (blob) => {
        setFileContent(await blob.text());
        setLoading(false);
      })
      .catch((error) => {
        console.error('[DocsViewer] Failed to load file:', activeDocVfsPath, error);
        const errorMsg =
          error.response?.status === 404
            ? `# File Not Found\n\nThe file \`${activeDocVfsPath}\` does not exist.`
            : error.code === 'ERR_NETWORK' || error.code === 'ERR_INCOMPLETE_CHUNKED_ENCODING'
              ? `# Network Error\n\nFailed to load the document due to a network error.\n\nThis could be a temporary issue. Try refreshing the document.`
              : `# Error\n\nFailed to load document: ${error.message || 'Unknown error'}`;
        setFileContent(errorMsg);
        setLoading(false);
      });
  }, [activeDocVfsPath, flow, flowTypeId]);

  useEffect(() => {
    loadFile();
  }, [loadFile]);

  if (!activeDocVfsPath) {
    return (
      <div className="flex h-full flex-1 flex-col bg-background">
        <div className="flex h-[52px] items-center border-b bg-muted/50 px-3">
          <h3 className="text-sm font-medium text-muted-foreground">No Document Selected</h3>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
          <FileText className="h-16 w-16 text-muted-foreground/50" />
          <p className="mt-4 text-lg text-muted-foreground">Select a document</p>
          <p className="mt-2 text-sm text-muted-foreground">Choose a document from the sidebar to view its contents</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-1 flex-col bg-background">
      <div className="flex h-[52px] items-center border-b bg-muted/50 px-3">
        <div className="flex-1">
          <h3 className="text-sm font-medium">{VFSPath.parse(activeDocVfsPath).filename.replace(/\.md$/, '')}</h3>
          <p className="text-xs text-muted-foreground">{activeDocVfsPath}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={loadFile}
          disabled={loading}
          title="Refresh document"
          className="h-8 w-8"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground">Loading document...</div>
        ) : fileContent ? (
          <div className="p-6">
            <MarkdownView value={fileContent} />
          </div>
        ) : (
          <div className="p-8 text-center text-muted-foreground">
            <FileText className="mx-auto h-12 w-12 text-muted-foreground/50" />
            <p className="mt-4">No content available</p>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
