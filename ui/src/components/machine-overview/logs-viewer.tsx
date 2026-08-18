import { useAgentContext } from '@src/contexts/agent-context';
import { ActionInfo, dataManager } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { AlertTriangle, Cpu, Heart, MemoryStick } from 'lucide-react';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

export interface LogsViewerHandle {
  refresh: () => Promise<void>;
}

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  alert?: 'cpu' | 'memory' | 'healthcheck';
  cpu_used_percent?: number;
  mem_used_percent?: number;
}

const AlertIcon: React.FC<{ alert: string }> = ({ alert }) => {
  switch (alert) {
    case 'cpu':
      return <Cpu className="h-3.5 w-3.5 text-orange-500" />;
    case 'memory':
      return <MemoryStick className="h-3.5 w-3.5 text-orange-500" />;
    case 'healthcheck':
      return <Heart className="h-3.5 w-3.5 text-red-500" />;
    default:
      return null;
  }
};

const LevelBadge: React.FC<{ level: string }> = ({ level }) => {
  const levelLower = level.toLowerCase();
  const classes = useMemo(() => {
    switch (levelLower) {
      case 'error':
        return 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300';
      case 'warn':
      case 'warning':
        return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300';
      case 'info':
        return 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300';
      case 'debug':
        return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
      default:
        return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
    }
  }, [levelLower]);

  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${classes}`}>{level}</span>;
};

interface LogsViewerProps {
  fetchOnMount?: boolean;
  isPaused?: boolean;
}

export const LogsViewer = forwardRef<LogsViewerHandle, LogsViewerProps>(
  ({ fetchOnMount = true, isPaused = false }, ref) => {
    const { computeNode } = useAgentContext();
    const { t } = useLingui();
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState('');
    const [alertsOnly, setAlertsOnly] = useState(false);

    const fetchLogs = useCallback(async () => {
      if (!computeNode?.id) return;

      // Skip fetch if sandbox is paused or in error state - E2B API will timeout
      if (isPaused) {
        setError(t`Sandbox is unavailable. Resume or recreate to view logs.`);
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const actionInfo = new ActionInfo('ops/logs', 'compute_node', computeNode.id, 'POST');
        actionInfo.bodyParameters = { limit: 200 };
        const data = await dataManager.callAction<{ limit: number }, LogEntry[]>(actionInfo);
        setLogs(data || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : t`Failed to fetch logs`);
      } finally {
        setIsLoading(false);
      }
    }, [computeNode?.id, isPaused]);

    // Expose refresh function to parent via ref
    useImperativeHandle(ref, () => ({
      refresh: fetchLogs,
    }));

    useEffect(() => {
      if (fetchOnMount) {
        void fetchLogs();
      }
    }, [fetchLogs, fetchOnMount]);

    const filteredLogs = useMemo(() => {
      let result = logs;

      if (alertsOnly) {
        result = result.filter((log) => log.alert);
      }

      if (filter) {
        const lowerFilter = filter.toLowerCase();
        result = result.filter(
          (log) =>
            log.message.toLowerCase().includes(lowerFilter) ||
            log.level.toLowerCase().includes(lowerFilter) ||
            log.timestamp.toLowerCase().includes(lowerFilter),
        );
      }

      return result;
    }, [logs, filter, alertsOnly]);

    // Count alerts
    const alertCounts = useMemo(() => {
      return {
        cpu: logs.filter((l) => l.alert === 'cpu').length,
        memory: logs.filter((l) => l.alert === 'memory').length,
        healthcheck: logs.filter((l) => l.alert === 'healthcheck').length,
      };
    }, [logs]);

    const totalAlerts = alertCounts.cpu + alertCounts.memory + alertCounts.healthcheck;

    return (
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-2">
          <div className="flex items-center gap-4">
            <h3 className="text-sm font-semibold">
              <Trans>Sandbox Logs</Trans>
            </h3>
            {totalAlerts > 0 && (
              <div className="flex items-center gap-3 text-xs">
                {alertCounts.cpu > 0 && (
                  <span className="flex items-center gap-1 text-orange-500">
                    <Cpu className="h-3 w-3" />
                    {alertCounts.cpu} <Trans>CPU</Trans>
                  </span>
                )}
                {alertCounts.memory > 0 && (
                  <span className="flex items-center gap-1 text-orange-500">
                    <MemoryStick className="h-3 w-3" />
                    {alertCounts.memory} <Trans>Memory</Trans>
                  </span>
                )}
                {alertCounts.healthcheck > 0 && (
                  <span className="flex items-center gap-1 text-red-500">
                    <Heart className="h-3 w-3" />
                    {alertCounts.healthcheck} <Trans>Health</Trans>
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <Input
            placeholder={t`Filter logs...`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-7 flex-1 text-xs"
          />
          <Button
            variant={alertsOnly ? 'default' : 'outline'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setAlertsOnly(!alertsOnly)}
          >
            <AlertTriangle className="me-1 h-3 w-3" />
            <Trans>Alerts Only ({totalAlerts})</Trans>
          </Button>
        </div>

        {/* Content */}
        {error ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <div className="text-center">
              <p className="text-red-500">{error}</p>
              <p className="mt-1 text-xs">
                <Trans>Use the refresh button in the toolbar to retry</Trans>
              </p>
            </div>
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            {isLoading ? (
              <Trans>Loading logs...</Trans>
            ) : alertsOnly ? (
              <Trans>No alert logs found</Trans>
            ) : (
              <Trans>No logs available</Trans>
            )}
          </div>
        ) : (
          <ScrollArea className="flex-1">
            <div className="space-y-0.5 p-2">
              {filteredLogs.map((log, idx) => (
                <div
                  key={`${log.timestamp}-${idx}`}
                  className={`flex items-start gap-2 rounded px-2 py-1.5 font-mono text-xs ${
                    log.alert
                      ? log.alert === 'healthcheck'
                        ? 'bg-red-50 dark:bg-red-950/30'
                        : 'bg-orange-50 dark:bg-orange-950/30'
                      : 'hover:bg-muted/30'
                  }`}
                >
                  {/* Timestamp */}
                  <span className="shrink-0 text-muted-foreground">
                    {new Date(log.timestamp).toLocaleTimeString('en-US', {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>

                  {/* Level */}
                  <LevelBadge level={log.level} />

                  {/* Alert icon */}
                  {log.alert && (
                    <span className="shrink-0">
                      <AlertIcon alert={log.alert} />
                    </span>
                  )}

                  {/* Message */}
                  <span className={`flex-1 break-all ${log.alert ? 'font-medium' : ''}`}>
                    {log.message}
                    {log.cpu_used_percent !== undefined && (
                      <span className="ms-2 text-orange-500">({log.cpu_used_percent.toFixed(1)}%)</span>
                    )}
                    {log.mem_used_percent !== undefined && (
                      <span className="ms-2 text-orange-500">({log.mem_used_percent.toFixed(1)}%)</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    );
  },
);

LogsViewer.displayName = 'LogsViewer';
