import { MarkdownView } from '@src/components/markdown-view';
import { Button } from '@src/components/ui/button';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { useFSRefContent, type FsRef } from '@src/hooks/use-fs-ref-content';
import { FileText, RefreshCw } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';

interface VfsMarkdownPaneProps {
  /** File to render, or null when nothing is selected (renders `emptyState`). */
  fsRef: FsRef | null;
  /** Header title. Defaults to the ref's path. */
  title?: string;
  /** Optional second header line (the full VFS path, typically). */
  subtitle?: string;
  /** Rendered instead of the pane when `fsRef` is null. */
  emptyState: ReactNode;
}

/**
 * Read-only markdown pane over a VFS file: load, refresh, and the
 * loading / error / empty / rendered states.
 *
 * Reads through `useFSRefContent` with `autoSave: false` — the hook is already
 * the one place that knows how to talk to the VFS and how to key a load on the
 * stable path string rather than the re-minted ref object.
 */
export function VfsMarkdownPane({ fsRef, title, subtitle, emptyState }: VfsMarkdownPaneProps) {
  const { t } = useLingui();
  const { content, isLoading, loadError, isMissing, reload } = useFSRefContent(fsRef, { autoSave: false });

  if (!fsRef) return <>{emptyState}</>;

  return (
    <div className="flex h-full flex-1 flex-col bg-background">
      <div className="flex h-[52px] items-center gap-3 border-b bg-muted/50 px-3">
        <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">{title ?? fsRef.path}</h3>
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={reload}
          disabled={isLoading}
          title={t`Refresh document`}
          className="h-8 w-8"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-6">
          {isLoading ? (
            <div className="flex h-64 items-center justify-center text-muted-foreground">
              <Trans>Loading document...</Trans>
            </div>
          ) : loadError || isMissing ? (
            <div className="flex h-64 flex-col items-center justify-center text-center">
              <FileText className="mb-3 h-12 w-12 text-destructive/50" />
              <p className="text-sm font-medium text-destructive">
                {isMissing ? t`This document no longer exists.` : loadError?.message}
              </p>
            </div>
          ) : content ? (
            <MarkdownView value={content} />
          ) : (
            <div className="flex h-64 flex-col items-center justify-center text-muted-foreground">
              <FileText className="mb-3 h-12 w-12 text-muted-foreground/50" />
              <p className="text-sm">
                <Trans>No content available</Trans>
              </p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
