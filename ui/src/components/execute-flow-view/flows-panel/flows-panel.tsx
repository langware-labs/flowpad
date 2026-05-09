import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { normalizeVfsPathToLocal } from '@sdk/react/hooks/use-fs-item-flows';
import { Flow, SendStatus, FSItem, QueryFilter, QueryRequest } from '@sdk';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { GitBranch, Play, RefreshCw, Square, Terminal } from 'lucide-react';
import { forwardRef, useCallback, useImperativeHandle, useMemo } from 'react';

export interface FlowsPanelProps {
  sourceFile?: FSItem | null;
}

export interface FlowsPanelRef {
  refresh: () => void;
}

/**
 * Format relative time from a timestamp
 */
const formatRelativeTime = (timestamp?: string | Date) => {
  if (!timestamp) return '';
  try {
    const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
  } catch {
    return '';
  }
};

/**
 * Get status display info
 */
const getStatusDisplay = (status?: SendStatus) => {
  switch (status) {
    case SendStatus.Running:
      return { label: 'Running', color: 'text-green-500', icon: Play };
    case SendStatus.Canceled:
      return { label: 'Canceled', color: 'text-yellow-500', icon: Square };
    case SendStatus.Error:
      return { label: 'Error', color: 'text-red-500', icon: Square };
    case SendStatus.Ready:
    default:
      return { label: 'Ready', color: 'text-muted-foreground', icon: Square };
  }
};

interface FlowItemProps {
  flow: Flow;
  onTerminalClick?: (terminalId: string) => void;
}

function FlowItem({ flow, onTerminalClick }: FlowItemProps) {
  const statusDisplay = getStatusDisplay(flow.sendStatus);
  const StatusIcon = statusDisplay.icon;
  const isRunning = flow.sendStatus === SendStatus.Running;
  const hasTerminal = !!flow.current_terminal_id;

  const handleTerminalClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (flow.current_terminal_id && onTerminalClick) {
        onTerminalClick(flow.current_terminal_id);
      }
    },
    [flow.current_terminal_id, onTerminalClick],
  );

  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-accent">
      {/* Flow info */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <GitBranch className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{flow.displayName}</p>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className={cn('flex items-center gap-1', statusDisplay.color)}>
              <StatusIcon className="h-2.5 w-2.5" />
              {statusDisplay.label}
            </span>
            {flow.updated_date && <span>{formatRelativeTime(flow.updated_date)}</span>}
          </div>
        </div>
      </div>

      {/* Terminal button - show if terminal session exists (allows reconnecting even after flow completes) */}
      {hasTerminal && (
        <button
          onClick={handleTerminalClick}
          className={cn(
            'flex items-center gap-1 rounded px-2 py-1 text-[10px]',
            isRunning
              ? 'bg-green-500/20 text-green-500 hover:bg-green-500/30'
              : 'bg-primary/10 text-primary hover:bg-primary/20',
          )}
          title={isRunning ? 'Open live terminal session' : 'Open terminal session'}
        >
          <Terminal className="h-3 w-3" />
          <span>{isRunning ? 'Live' : 'Terminal'}</span>
        </button>
      )}
    </div>
  );
}

export const FlowsPanel = forwardRef<FlowsPanelRef, FlowsPanelProps>(function FlowsPanel({ sourceFile }, ref) {
  const { project } = useAgentContext();
  const { navigation } = useDockNavigation();

  // Normalize the VFS path to use @local format for consistent querying
  // This ensures we can find flows regardless of whether the URL uses UUID or @local
  const normalizedVfsPath = useMemo(
    () => normalizeVfsPathToLocal(sourceFile?.vfs_abs_path),
    [sourceFile?.vfs_abs_path],
  );

  // Build query for flows matching the source VFS path
  const flowsScope = useMemo(() => (project?.typeId ? [project.typeId] : []), [project?.typeId]);

  // Determine if we should enable the query
  const shouldFetch = !!normalizedVfsPath && flowsScope.length > 0;

  const flowsQuery = useMemo(() => {
    // Always create a valid query, but it will only be used when shouldFetch is true
    // Note: Don't expand auth_scopes - not supported on Flow entity
    return QueryFilter.parse(
      {
        match: { asset_ref: normalizedVfsPath || '' },
      },
      Flow.type,
    );
  }, [normalizedVfsPath]);

  const request = useMemo(() => {
    // Always create a valid request - use enabled option to control fetching
    return new QueryRequest({
      type: Flow.type,
      scope: flowsScope.length > 0 ? flowsScope : [],
      query: flowsQuery,
      name: 'useProcessesBySource',
    });
  }, [flowsScope, flowsQuery]);

  const {
    data: flows,
    isLoading,
    error,
    refetch,
  } = useEntitiesQuery<Flow>(request, {
    enabled: shouldFetch,
  });

  // Debug logging
  console.log('[FlowsPanel] Query state:', {
    sourceVfsPath: sourceFile?.vfs_abs_path,
    normalizedVfsPath,
    shouldFetch,
    flowsCount: flows?.length ?? 0,
    isLoading,
    error: error?.message,
  });

  // Handle refresh
  const handleRefresh = useCallback(() => {
    console.log('[FlowsPanel] handleRefresh called, refetch:', !!refetch);
    void refetch?.();
  }, [refetch]);

  // Expose refresh function via ref for parent components to call
  useImperativeHandle(ref, () => ({
    refresh: handleRefresh,
  }));

  // Handle terminal click - navigate to shell
  const handleTerminalClick = useCallback(
    (shellId: string) => {
      void navigation.openSession(shellId);
    },
    [navigation],
  );

  // Don't render if no source file
  if (!sourceFile) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-xs text-muted-foreground">Select a file to see connected flows</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-end border-b px-2 py-1">
        <button
          onClick={handleRefresh}
          disabled={isLoading}
          className="rounded p-1 hover:bg-accent disabled:opacity-50"
          title="Refresh flows"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
        </button>
      </div>
      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="px-4 py-2 text-xs text-destructive">
            <p>Error loading flows: {error.message}</p>
          </div>
        )}

        {!error && !isLoading && (!flows || flows.length === 0) && (
          <div className="flex h-full items-center justify-center px-4 py-8 text-center">
            <div>
              <GitBranch className="mx-auto h-8 w-8 text-muted-foreground/50" />
              <p className="mt-2 text-xs text-muted-foreground">No flows connected to this file</p>
            </div>
          </div>
        )}

        {!error && flows && flows.length > 0 && (
          <div className="divide-y">
            {flows.map((flow) => (
              <FlowItem key={flow.id} flow={flow} onTerminalClick={handleTerminalClick} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
