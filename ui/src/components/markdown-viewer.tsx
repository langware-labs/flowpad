import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { AgenticProcess, FSItem } from '@sdk';
import { MarkdownView } from '@src/components/markdown-view';
import { Button } from '@src/components/ui/button';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { useViewerStore } from '@src/hooks/flow-hooks';
import { RefreshCw, Loader2, FileText } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

export function MarkdownViewer() {
  const { t } = useLingui();
  const { flow } = useAgentContext();
  const { currentContext } = useViewerStore();
  const [content, setContent] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filePath = currentContext?.codeRef?.path;

  const fetchMarkdownContent = useCallback(async () => {
    if (!flow?.id || !filePath) {
      setContent('');
      return;
    }

    const fetchFn = isRefreshing ? setIsRefreshing : setIsLoading;
    fetchFn(true);
    setError(null);

    try {
      const fsItem = new FSItem({
        vfs_abs_path: `${AgenticProcess.type}-${flow.id}/${filePath}`,
      });

      const fileContent = await fsItem.fetchContent();

      if (fileContent !== undefined) {
        setContent(fileContent);
      } else {
        setError(t`Failed to load markdown file`);
      }
    } catch (err) {
      console.error('Error fetching markdown file:', err);
      setError(err instanceof Error ? err.message : t`Failed to load markdown file`);
    } finally {
      fetchFn(false);
    }
  }, [flow?.id, filePath, isRefreshing]);

  useEffect(() => {
    void fetchMarkdownContent();
  }, [fetchMarkdownContent]);

  const handleRefresh = () => {
    setIsRefreshing(true);
    void fetchMarkdownContent();
  };

  if (!filePath) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <div className="text-center">
          <FileText className="mx-auto mb-3 h-12 w-12 text-muted-foreground/50" />
          <p className="text-sm font-medium"><Trans>No markdown file selected</Trans></p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Top Bar */}
      <div className="flex items-center justify-between border-b bg-background px-4 py-3">
        <div className="flex items-center gap-3">
          <FileText className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-sm font-medium">{filePath}</h2>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing} className="gap-2">
          <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          {t`Refresh`}
        </Button>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-6">
          {isLoading ? (
            <div className="flex h-64 items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex h-64 flex-col items-center justify-center text-center">
              <FileText className="mb-3 h-12 w-12 text-destructive/50" />
              <p className="text-sm font-medium text-destructive">{error}</p>
            </div>
          ) : content ? (
            <MarkdownView value={content} />
          ) : (
            <div className="flex h-64 items-center justify-center text-muted-foreground">
              <p className="text-sm"><Trans>No content available</Trans></p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
