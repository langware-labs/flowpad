import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { ActionInfo, AgenticProcess, dataManager, FSItem, TypeId, VFSPath } from '@sdk';
import { MarkdownView } from '@src/components/markdown-view';
import { Button } from '@src/components/ui/button';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { useDockNavigation } from '@src/navigation';
import { useAction } from '@src/hooks/use-action';
import { useViewerStore } from '@src/hooks/flow-hooks';
import { FileText, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';

interface DocsFile {
  path: string;
  name: string;
  isDir: boolean;
}

export function DocsViewer() {
  const { processId } = useParams();
  const flowTypeId = useMemo(() => new TypeId(AgenticProcess.type, processId), [processId]);
  const { flow } = useAgentContext();
  const { navigation } = useDockNavigation();
  const { currentContext } = useViewerStore();
  const [fileContent, setFileContent] = useState<string>('');
  const [loading, setLoading] = useState(false);

  // Derive active VFS path from currentContext (synced from URL in FlowPage)
  const activeDocVfsPath = useMemo(() => {
    return currentContext?.codeRef?.path || null;
  }, [currentContext]);

  // Fetch docs directory listing
  const browseDocsActionInfo = useMemo(() => {
    const actionInfo = new ActionInfo('fs', flowTypeId.type, flowTypeId.id, 'GET');
    actionInfo.subpath = ['browse', 'docs'];
    return actionInfo;
  }, [flowTypeId]);

  const {
    data: docsItems,
    isLoading: isLoadingDocs,
    error: docsError,
    refetch: refetchDocs,
  } = useAction<Required<Pick<FSItem, 'vfs_abs_path' | 'display_name' | 'is_dir'>>[]>(browseDocsActionInfo, {
    retry: false, // Don't retry on 404 or other errors
  });

  const docFiles: DocsFile[] = useMemo(() => {
    if (!docsItems) return [];

    return docsItems
      .filter((item) => !item.is_dir && item.display_name.endsWith('.md'))
      .map((item) => ({
        path: `docs/${item.display_name}`, // Full path: docs/filename for sidebar navigation
        name: item.display_name,
        isDir: false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [docsItems]);

  // Fetch file content when activeDocVfsPath changes
  useEffect(() => {
    if (!activeDocVfsPath || !flow) {
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
        const text = await blob.text();
        setFileContent(text);
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

  const handleFileClick = useCallback(
    (file: DocsFile) => {
      navigation.openFile(file.path);
    },
    [navigation],
  );

  const refreshCurrentFile = useCallback(() => {
    if (!activeDocVfsPath) return;

    setLoading(true);
    const actionInfo = new ActionInfo('fs', flowTypeId.type, flowTypeId.id, 'GET');
    actionInfo.subpath = ['download', activeDocVfsPath];
    actionInfo.isRawResponse = true;
    actionInfo.responseType = 'blob';

    dataManager
      .callAction<unknown, Blob>(actionInfo)
      .then(async (blob) => {
        const text = await blob.text();
        setFileContent(text);
        setLoading(false);
      })
      .catch((error) => {
        console.error('[DocsViewer] Failed to refresh file:', activeDocVfsPath, error);
        const errorMsg =
          error.response?.status === 404
            ? `# File Not Found\n\nThe file \`${activeDocVfsPath}\` does not exist.`
            : error.code === 'ERR_NETWORK' || error.code === 'ERR_INCOMPLETE_CHUNKED_ENCODING'
              ? `# Network Error\n\nFailed to load the document due to a network error.\n\nThis could be a temporary issue. Try refreshing the document.`
              : `# Error\n\nFailed to load document: ${error.message || 'Unknown error'}`;
        setFileContent(errorMsg);
        setLoading(false);
      });
  }, [activeDocVfsPath, flowTypeId]);

  // Render sidebar
  const renderSidebar = () => (
    <div className="flex h-full w-64 flex-col border-r bg-background">
      <div className="flex h-[52px] items-center justify-between border-b bg-muted/50 px-3">
        <h2 className="text-sm font-semibold">Documentation</h2>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            void refetchDocs();
          }}
          disabled={isLoadingDocs}
          title="Refresh docs"
          className="h-8 w-8"
        >
          <RefreshCw className={`h-4 w-4 ${isLoadingDocs ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {isLoadingDocs ? (
          <div className="p-4 text-center text-xs text-muted-foreground">Loading...</div>
        ) : docsError ? (
          <div className="p-4 text-center">
            <FileText className="mx-auto h-8 w-8 text-muted-foreground/50" />
            <p className="mt-2 text-xs text-muted-foreground">Docs folder not found</p>
          </div>
        ) : docFiles.length === 0 ? (
          <div className="p-4 text-center">
            <FileText className="mx-auto h-8 w-8 text-muted-foreground/50" />
            <p className="mt-2 text-xs text-muted-foreground">No docs</p>
          </div>
        ) : (
          <div className="p-2">
            <div className="space-y-0.5">
              {docFiles.map((file) => {
                const isActive = activeDocVfsPath === file.path;
                return (
                  <button
                    key={file.path}
                    onClick={() => handleFileClick(file)}
                    className={`flex w-full items-center gap-2 rounded-md p-2 text-left text-xs transition-colors ${
                      isActive ? 'bg-primary/10 font-medium text-primary' : 'text-foreground hover:bg-muted'
                    }`}
                  >
                    <FileText className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate">{file.name.replace('.md', '')}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </ScrollArea>
    </div>
  );

  // Render main content area
  const renderContent = () => {
    if (!activeDocVfsPath) {
      return (
        <div className="flex h-full flex-1 flex-col bg-background">
          <div className="flex h-[52px] items-center border-b bg-muted/50 px-3">
            <div className="flex-1">
              <h3 className="text-sm font-medium text-muted-foreground">No Document Selected</h3>
            </div>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
            <FileText className="h-16 w-16 text-muted-foreground/50" />
            <p className="mt-4 text-lg text-muted-foreground">Select a document</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Choose a document from the sidebar to view its contents
            </p>
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
            onClick={refreshCurrentFile}
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
  };

  return (
    <div className="flex h-full bg-background">
      {renderSidebar()}
      {renderContent()}
    </div>
  );
}
