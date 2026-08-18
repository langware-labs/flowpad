import { useAgentContext } from '@src/contexts/agent-context';
import {
  ActionInfo,
  ComputeProviderType,
  ExecutionEnvironmentStatus,
  MachineStatus,
  MachineSubview,
  ViewType,
  dataManager,
} from '@sdk';
import { LogsViewer, LogsViewerHandle } from './logs-viewer';
import { MetricsChart, MetricsChartHandle } from './metrics-chart';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { DockPointer } from '@src/navigation/DockPointer';
import { NodeSecrets } from '@src/components/machine-overview/node-secrets';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Copy,
  FileText,
  KeyRound,
  Network,
  Pause,
  Play,
  RefreshCw,
  Server,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type SortDirection = 'asc' | 'desc' | null;
type ProcessSortKey = 'pid' | 'name' | 'cpu_percent' | 'memory_mb' | 'status';
type NetworkSortKey = 'port' | 'type' | 'pid' | 'process_name' | 'status';

interface SortState<T> {
  key: T | null;
  direction: SortDirection;
}

function SortIcon({ direction }: { direction: SortDirection }) {
  if (direction === 'asc') return <ArrowUp className="ms-1 inline h-3 w-3" />;
  if (direction === 'desc') return <ArrowDown className="ms-1 inline h-3 w-3" />;
  return <ArrowUpDown className="ms-1 inline h-3 w-3 opacity-30" />;
}

function SortableHeader<T extends string>({
  label,
  sortKey,
  currentSort,
  onSort,
  className,
}: {
  label: string;
  sortKey: T;
  currentSort: SortState<T>;
  onSort: (key: T) => void;
  className?: string;
}) {
  return (
    <th
      className={`cursor-pointer select-none px-2 py-1.5 font-medium hover:bg-muted/70 ${className || ''}`}
      onClick={() => onSort(sortKey)}
    >
      {label}
      <SortIcon direction={currentSort.key === sortKey ? currentSort.direction : null} />
    </th>
  );
}

export const MachineOverview: React.FC = () => {
  const { computeNode, project } = useAgentContext();
  const { navigation, currentDock } = useDockNavigation();
  const { t } = useLingui();
  const [machineStatus, setMachineStatus] = useState<MachineStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processFilter, setProcessFilter] = useState('');
  const [networkFilter, setNetworkFilter] = useState('');
  const [processSort, setProcessSort] = useState<SortState<ProcessSortKey>>({ key: 'cpu_percent', direction: 'desc' });
  const [networkSort, setNetworkSort] = useState<SortState<NetworkSortKey>>({ key: 'port', direction: 'asc' });

  // Refs for sub-components to expose refresh functions
  const logsViewerRef = useRef<LogsViewerHandle>(null);
  const metricsChartRef = useRef<MetricsChartHandle>(null);

  // State for delayed tooltip on Sandbox hover (3 second delay)
  const [showSandboxTooltip, setShowSandboxTooltip] = useState(false);
  const sandboxHoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sandboxHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHoveringTooltipRef = useRef(false);

  const handleSandboxMouseEnter = useCallback(() => {
    // Clear any pending hide timeout
    if (sandboxHideTimeoutRef.current) {
      clearTimeout(sandboxHideTimeoutRef.current);
      sandboxHideTimeoutRef.current = null;
    }
    // Start 3 second delay to show tooltip
    sandboxHoverTimeoutRef.current = setTimeout(() => {
      setShowSandboxTooltip(true);
    }, 3000);
  }, []);

  const handleSandboxMouseLeave = useCallback(() => {
    // Clear the show timeout
    if (sandboxHoverTimeoutRef.current) {
      clearTimeout(sandboxHoverTimeoutRef.current);
      sandboxHoverTimeoutRef.current = null;
    }
    // Delay hiding to allow moving to tooltip content
    sandboxHideTimeoutRef.current = setTimeout(() => {
      if (!isHoveringTooltipRef.current) {
        setShowSandboxTooltip(false);
      }
    }, 100);
  }, []);

  const handleTooltipMouseEnter = useCallback(() => {
    isHoveringTooltipRef.current = true;
    if (sandboxHideTimeoutRef.current) {
      clearTimeout(sandboxHideTimeoutRef.current);
      sandboxHideTimeoutRef.current = null;
    }
  }, []);

  const handleTooltipMouseLeave = useCallback(() => {
    isHoveringTooltipRef.current = false;
    setShowSandboxTooltip(false);
  }, []);

  const handleCopyComputeNodeId = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (computeNode?.id) {
        void navigator.clipboard.writeText(computeNode.id);
      }
    },
    [computeNode?.id],
  );

  const handleCopyProviderId = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (computeNode?.node_provider_id) {
        void navigator.clipboard.writeText(computeNode.node_provider_id);
      }
    },
    [computeNode?.node_provider_id],
  );

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (sandboxHoverTimeoutRef.current) {
        clearTimeout(sandboxHoverTimeoutRef.current);
      }
      if (sandboxHideTimeoutRef.current) {
        clearTimeout(sandboxHideTimeoutRef.current);
      }
    };
  }, []);

  // Derive active tab from URL pointer, default to processes
  const subview = currentDock?.pointer as MachineSubview | undefined;
  const activeTab = subview || MachineSubview.PROCESSES;

  // Handle tab change via navigation
  const handleTabChange = useCallback(
    (tab: string) => {
      navigation.openDock(new DockPointer(ViewType.MACHINE, tab as MachineSubview));
    },
    [navigation],
  );

  const handleProcessSort = useCallback((key: ProcessSortKey) => {
    setProcessSort((prev) => ({
      key,
      direction:
        prev.key === key ? (prev.direction === 'asc' ? 'desc' : prev.direction === 'desc' ? null : 'asc') : 'asc',
    }));
  }, []);

  const handleNetworkSort = useCallback((key: NetworkSortKey) => {
    setNetworkSort((prev) => ({
      key,
      direction:
        prev.key === key ? (prev.direction === 'asc' ? 'desc' : prev.direction === 'desc' ? null : 'asc') : 'asc',
    }));
  }, []);

  const sortedProcesses = useMemo(() => {
    if (!machineStatus?.processes) return [];
    const filtered = machineStatus.processes.filter(
      (p) =>
        !processFilter ||
        p.name.toLowerCase().includes(processFilter.toLowerCase()) ||
        p.pid.toString().includes(processFilter) ||
        p.status.toLowerCase().includes(processFilter.toLowerCase()),
    );
    if (!processSort.key || !processSort.direction) return filtered;
    return [...filtered].sort((a, b) => {
      const key = processSort.key!;
      const aVal = a[key];
      const bVal = b[key];
      const cmp = typeof aVal === 'number' ? aVal - (bVal as number) : String(aVal).localeCompare(String(bVal));
      return processSort.direction === 'asc' ? cmp : -cmp;
    });
  }, [machineStatus?.processes, processFilter, processSort]);

  const sortedNetwork = useMemo(() => {
    if (!machineStatus?.network) return [];
    const filtered = machineStatus.network.filter(
      (c) =>
        !networkFilter ||
        c.port.toString().includes(networkFilter) ||
        c.process_name.toLowerCase().includes(networkFilter.toLowerCase()) ||
        c.type.toLowerCase().includes(networkFilter.toLowerCase()),
    );
    if (!networkSort.key || !networkSort.direction) return filtered;
    return [...filtered].sort((a, b) => {
      const key = networkSort.key!;
      const aVal = a[key];
      const bVal = b[key];
      const cmp = typeof aVal === 'number' ? aVal - (bVal as number) : String(aVal).localeCompare(String(bVal));
      return networkSort.direction === 'asc' ? cmp : -cmp;
    });
  }, [machineStatus?.network, networkFilter, networkSort]);

  const fetchMachineStatus = useCallback(async () => {
    if (!computeNode?.id) return;

    setIsLoading(true);
    setError(null);

    try {
      setMachineStatus(await computeNode.getMachineStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch machine status');
    } finally {
      setIsLoading(false);
    }
  }, [computeNode]);

  useEffect(() => {
    void fetchMachineStatus();
  }, [fetchMachineStatus]);

  const [isPauseResumeLoading, setIsPauseResumeLoading] = useState(false);

  const handlePauseResume = useCallback(async () => {
    if (!computeNode?.id || !machineStatus) return;

    const isPaused = machineStatus.node_provider_status === ExecutionEnvironmentStatus.PAUSED;
    const operation = isPaused ? 'resume' : 'pause';

    setIsPauseResumeLoading(true);
    try {
      const actionInfo = new ActionInfo(`ops/${operation}`, 'compute_node', computeNode.id, 'POST');
      await dataManager.callAction<undefined, unknown>(actionInfo);
      await fetchMachineStatus();
    } catch (err) {
      console.error(`Failed to ${operation} compute node:`, err);
    } finally {
      setIsPauseResumeLoading(false);
    }
  }, [computeNode?.id, machineStatus, fetchMachineStatus]);

  // Track if any refresh is in progress (for the toolbar button)
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Contextual refresh based on active tab
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      switch (activeTab) {
        case MachineSubview.PROCESSES:
        case MachineSubview.NETWORK:
          // Both processes and network use machine status data
          await fetchMachineStatus();
          break;
        case MachineSubview.METRICS:
          // Metrics tab has its own refresh via ref
          await metricsChartRef.current?.refresh();
          break;
        case MachineSubview.LOGS:
          // Logs tab has its own refresh via ref
          await logsViewerRef.current?.refresh();
          break;
        default:
          await fetchMachineStatus();
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [activeTab, fetchMachineStatus]);

  return (
    <div className="relative h-full w-full">
      {/* Toolbar */}
      <div className="flex h-9 items-center justify-between gap-1 border-b bg-muted/30 px-2">
        {/* Left side: Sandbox selector */}
        <div className="flex items-center gap-2">
          <TooltipProvider delayDuration={0}>
            <Tooltip open={showSandboxTooltip}>
              <TooltipTrigger asChild>
                <div onMouseEnter={handleSandboxMouseEnter} onMouseLeave={handleSandboxMouseLeave}>
                  <Select value="sandbox" disabled>
                    <SelectTrigger className="h-7 w-auto min-w-[120px] text-xs">
                      <SelectValue>
                        <Trans>Sandbox</Trans>
                        {machineStatus && (
                          <span
                            className={`ms-1 ${
                              machineStatus.node_provider_status === ExecutionEnvironmentStatus.READY
                                ? 'text-green-600'
                                : machineStatus.node_provider_status === ExecutionEnvironmentStatus.PAUSED
                                  ? 'text-yellow-600'
                                  : 'text-red-600'
                            }`}
                          >
                            ({machineStatus.node_provider_status.toLowerCase().replace('_', ' ')})
                          </span>
                        )}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sandbox" className="text-xs">
                        <Trans>Sandbox</Trans>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                className="text-xs"
                onMouseEnter={handleTooltipMouseEnter}
                onMouseLeave={handleTooltipMouseLeave}
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-1">
                    <span className="font-medium">
                      <Trans>Compute Node ID:</Trans>
                    </span>{' '}
                    <span className="font-mono">{computeNode?.id || 'N/A'}</span>
                    {computeNode?.id && (
                      <button
                        onClick={handleCopyComputeNodeId}
                        className="ms-1 rounded p-0.5 hover:bg-muted"
                        title={t`Copy Compute Node ID`}
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  <div>
                    <span className="font-medium">
                      <Trans>Provider:</Trans>
                    </span>{' '}
                    {computeNode?.node_provider_type || 'N/A'}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="font-medium">
                      <Trans>Provider ID:</Trans>
                    </span>{' '}
                    <span className="font-mono">{computeNode?.node_provider_id || 'N/A'}</span>
                    {computeNode?.node_provider_id && (
                      <button
                        onClick={handleCopyProviderId}
                        className="ms-1 rounded p-0.5 hover:bg-muted"
                        title={t`Copy Provider ID`}
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  {machineStatus && (
                    <>
                      {machineStatus.node_info && (
                        <div className="border-t pt-1">
                          <span className="font-medium">
                            <Trans>Size:</Trans>
                          </span>{' '}
                          {machineStatus.node_info.size === 'sm' ? (
                            <Trans>Small</Trans>
                          ) : machineStatus.node_info.size === 'md' ? (
                            <Trans>Medium</Trans>
                          ) : machineStatus.node_info.size === 'lg' ? (
                            <Trans>Large</Trans>
                          ) : (
                            machineStatus.node_info.size
                          )}{' '}
                          ({machineStatus.node_info.cpu_count} <Trans>CPU</Trans>, {machineStatus.node_info.memory_gb}
                          <Trans>GB</Trans>)
                          {machineStatus.node_info.template_version && (
                            <>
                              <br />
                              <span className="font-medium">
                                <Trans>Template:</Trans>
                              </span>{' '}
                              {machineStatus.node_info.template_version}
                            </>
                          )}
                        </div>
                      )}
                      <div className={machineStatus.node_info ? '' : 'border-t pt-1'}>
                        <span className="font-medium">
                          <Trans>Status:</Trans>
                        </span>{' '}
                        <span
                          className={
                            machineStatus.node_provider_status === ExecutionEnvironmentStatus.READY
                              ? 'text-green-600'
                              : machineStatus.node_provider_status === ExecutionEnvironmentStatus.PAUSED
                                ? 'text-yellow-600'
                                : 'text-red-600'
                          }
                        >
                          {machineStatus.node_provider_status}
                        </span>
                      </div>
                      {machineStatus.status_msg && (
                        <div className="text-yellow-500">
                          <span className="font-medium">
                            <Trans>Status:</Trans>
                          </span>{' '}
                          {machineStatus.status_msg}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {machineStatus && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {/* Show size label with specs and tooltip for full node_info */}
              {machineStatus.node_info && (
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help border-e border-border pe-3">
                        {machineStatus.node_info.size === 'sm' ? (
                          <Trans>Small</Trans>
                        ) : machineStatus.node_info.size === 'md' ? (
                          <Trans>Medium</Trans>
                        ) : machineStatus.node_info.size === 'lg' ? (
                          <Trans>Large</Trans>
                        ) : (
                          machineStatus.node_info.size
                        )}{' '}
                        ({machineStatus.node_info.cpu_count} <Trans>CPU</Trans>, {machineStatus.node_info.memory_gb}
                        <Trans>GB</Trans>)
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">
                      <div className="space-y-1">
                        <div>
                          <span className="font-medium">
                            <Trans>Size:</Trans>
                          </span>{' '}
                          {machineStatus.node_info.size === 'sm' ? (
                            <Trans>Small</Trans>
                          ) : machineStatus.node_info.size === 'md' ? (
                            <Trans>Medium</Trans>
                          ) : machineStatus.node_info.size === 'lg' ? (
                            <Trans>Large</Trans>
                          ) : (
                            machineStatus.node_info.size
                          )}
                        </div>
                        <div>
                          <span className="font-medium">
                            <Trans>CPU:</Trans>
                          </span>{' '}
                          {machineStatus.node_info.cpu_count} cores
                        </div>
                        <div>
                          <span className="font-medium">
                            <Trans>Memory:</Trans>
                          </span>{' '}
                          {machineStatus.node_info.memory_gb} GB
                        </div>
                        <div>
                          <span className="font-medium">
                            <Trans>OS:</Trans>
                          </span>{' '}
                          {machineStatus.node_info.os_type}
                        </div>
                        {machineStatus.node_info.template_version && (
                          <div>
                            <span className="font-medium">
                              <Trans>Template:</Trans>
                            </span>{' '}
                            {machineStatus.node_info.template_version}
                          </div>
                        )}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              <span>
                <Trans>CPU:</Trans> {machineStatus.cpu_percent.toFixed(1)}%
              </span>
              <span>
                <Trans>RAM:</Trans> {machineStatus.memory_percent.toFixed(1)}%
              </span>
            </div>
          )}
        </div>

        {/* Right side: Pause/Resume and Refresh buttons */}
        <div className="flex items-center gap-1">
          {machineStatus &&
            (machineStatus.node_provider_status === ExecutionEnvironmentStatus.READY ||
              machineStatus.node_provider_status === ExecutionEnvironmentStatus.PAUSED) && (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => void handlePauseResume()}
                      disabled={isPauseResumeLoading}
                    >
                      {machineStatus.node_provider_status === ExecutionEnvironmentStatus.PAUSED ? (
                        <Play className={`h-4 w-4 ${isPauseResumeLoading ? 'animate-pulse' : ''}`} />
                      ) : (
                        <Pause className={`h-4 w-4 ${isPauseResumeLoading ? 'animate-pulse' : ''}`} />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p>
                      {machineStatus.node_provider_status === ExecutionEnvironmentStatus.PAUSED ? (
                        <Trans>Resume</Trans>
                      ) : (
                        <Trans>Pause</Trans>
                      )}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => void handleRefresh()}
                  disabled={isRefreshing || isLoading || configLoading}
                >
                  <RefreshCw
                    className={`h-4 w-4 ${isRefreshing || isLoading || configLoading ? 'animate-spin' : ''}`}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>
                  <Trans>Refresh</Trans>
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {/* Content with tabs */}
      <div className="h-[calc(100%-36px)] w-full overflow-auto">
        {error ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <div className="text-center">
              <p className="text-red-500">{error}</p>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => void handleRefresh()}>
                <Trans>Retry</Trans>
              </Button>
            </div>
          </div>
        ) : !machineStatus ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            {isLoading ? <Trans>Loading...</Trans> : <Trans>No machine data available</Trans>}
          </div>
        ) : (
          <Tabs value={activeTab} onValueChange={handleTabChange} className="h-full">
            <div className="border-b px-2">
              <TabsList className="h-8">
                <TabsTrigger value={MachineSubview.PROCESSES} className="h-7 text-xs">
                  <Server className="me-1.5 h-3.5 w-3.5" />
                  Processes ({sortedProcesses.length}
                  {processFilter ? `/${machineStatus.processes.length}` : ''})
                </TabsTrigger>
                <TabsTrigger value={MachineSubview.NETWORK} className="h-7 text-xs">
                  <Network className="me-1.5 h-3.5 w-3.5" />
                  Network ({sortedNetwork.length}
                  {networkFilter ? `/${machineStatus.network.length}` : ''})
                </TabsTrigger>
                <TabsTrigger value={MachineSubview.SECRETS} className="h-7 text-xs">
                  <KeyRound className="me-1.5 h-3.5 w-3.5" />
                  <Trans>Secrets</Trans>
                </TabsTrigger>
                {computeNode?.node_provider_type === ComputeProviderType.E2B && (
                  <>
                    <TabsTrigger value={MachineSubview.METRICS} className="h-7 text-xs">
                      <Activity className="me-1.5 h-3.5 w-3.5" />
                      <Trans>Metrics</Trans>
                    </TabsTrigger>
                    <TabsTrigger value={MachineSubview.LOGS} className="h-7 text-xs">
                      <FileText className="me-1.5 h-3.5 w-3.5" />
                      <Trans>Logs</Trans>
                    </TabsTrigger>
                  </>
                )}
              </TabsList>
            </div>

            <TabsContent value={MachineSubview.PROCESSES} className="mt-0 h-[calc(100%-40px)] overflow-auto">
              <div className="sticky top-0 z-10 border-b bg-background px-2 py-1">
                <Input
                  placeholder={t`Filter processes...`}
                  value={processFilter}
                  onChange={(e) => setProcessFilter(e.target.value)}
                  className="h-7 text-xs"
                />
              </div>
              <table className="w-full text-xs">
                <thead className="sticky top-9 z-10 bg-background shadow-sm">
                  <tr className="border-b">
                    <SortableHeader
                      label={t`PID`}
                      sortKey="pid"
                      currentSort={processSort}
                      onSort={handleProcessSort}
                      className="text-start"
                    />
                    <SortableHeader
                      label={t`Name`}
                      sortKey="name"
                      currentSort={processSort}
                      onSort={handleProcessSort}
                      className="text-start"
                    />
                    <SortableHeader
                      label={t`CPU %`}
                      sortKey="cpu_percent"
                      currentSort={processSort}
                      onSort={handleProcessSort}
                      className="text-end"
                    />
                    <SortableHeader
                      label={t`RAM (MB)`}
                      sortKey="memory_mb"
                      currentSort={processSort}
                      onSort={handleProcessSort}
                      className="text-end"
                    />
                    <SortableHeader
                      label={t`Status`}
                      sortKey="status"
                      currentSort={processSort}
                      onSort={handleProcessSort}
                      className="text-start"
                    />
                    <th className="px-2 py-1.5 text-start font-medium">
                      <Trans>Path</Trans>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedProcesses.map((proc) => (
                    <tr key={proc.pid} className="border-b hover:bg-muted/30">
                      <td className="px-2 py-1 font-mono">{proc.pid}</td>
                      <td className="max-w-[150px] truncate px-2 py-1" title={proc.name}>
                        {proc.name}
                      </td>
                      <td className="px-2 py-1 text-end font-mono">{proc.cpu_percent.toFixed(1)}</td>
                      <td className="px-2 py-1 text-end font-mono">{proc.memory_mb.toFixed(1)}</td>
                      <td className="px-2 py-1">
                        <span
                          className={`rounded px-1 py-0.5 ${
                            proc.status === 'running'
                              ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                              : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300'
                          }`}
                        >
                          {proc.status}
                        </span>
                      </td>
                      <td
                        className="max-w-[200px] truncate px-2 py-1 font-mono text-muted-foreground"
                        title={proc.path}
                      >
                        {proc.path || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TabsContent>

            <TabsContent value={MachineSubview.NETWORK} className="mt-0 h-[calc(100%-40px)] overflow-auto">
              <div className="sticky top-0 z-10 border-b bg-background px-2 py-1">
                <Input
                  placeholder={t`Filter network...`}
                  value={networkFilter}
                  onChange={(e) => setNetworkFilter(e.target.value)}
                  className="h-7 text-xs"
                />
              </div>
              <table className="w-full text-xs">
                <thead className="sticky top-9 z-10 bg-background shadow-sm">
                  <tr className="border-b">
                    <SortableHeader
                      label={t`Port`}
                      sortKey="port"
                      currentSort={networkSort}
                      onSort={handleNetworkSort}
                      className="text-start"
                    />
                    <SortableHeader
                      label={t`Type`}
                      sortKey="type"
                      currentSort={networkSort}
                      onSort={handleNetworkSort}
                      className="text-start"
                    />
                    <SortableHeader
                      label={t`PID`}
                      sortKey="pid"
                      currentSort={networkSort}
                      onSort={handleNetworkSort}
                      className="text-start"
                    />
                    <SortableHeader
                      label={t`Process`}
                      sortKey="process_name"
                      currentSort={networkSort}
                      onSort={handleNetworkSort}
                      className="text-start"
                    />
                    <SortableHeader
                      label={t`Status`}
                      sortKey="status"
                      currentSort={networkSort}
                      onSort={handleNetworkSort}
                      className="text-start"
                    />
                    <th className="px-2 py-1.5 text-start font-medium">
                      <Trans>Path</Trans>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedNetwork.map((conn, idx) => (
                    <tr key={`${conn.port}-${conn.pid}-${idx}`} className="border-b hover:bg-muted/30">
                      <td className="px-2 py-1 font-mono font-medium">{conn.port}</td>
                      <td className="px-2 py-1">{conn.type}</td>
                      <td className="px-2 py-1 font-mono">{conn.pid}</td>
                      <td className="max-w-[150px] truncate px-2 py-1" title={conn.process_name}>
                        {conn.process_name}
                      </td>
                      <td className="px-2 py-1">
                        <span
                          className={`rounded px-1 py-0.5 ${
                            conn.status === 'LISTEN'
                              ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                              : conn.status === 'ESTABLISHED'
                                ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                                : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                          }`}
                        >
                          {conn.status}
                        </span>
                      </td>
                      <td
                        className="max-w-[200px] truncate px-2 py-1 font-mono text-muted-foreground"
                        title={conn.process_path}
                      >
                        {conn.process_path || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TabsContent>

            <TabsContent value={MachineSubview.SECRETS} className="mt-0 h-[calc(100%-40px)] overflow-auto">
              <NodeSecrets computeNode={computeNode} project={project} />
            </TabsContent>

            {/* Metrics Tab - E2B only */}
            {computeNode?.node_provider_type === ComputeProviderType.E2B && (
              <TabsContent value={MachineSubview.METRICS} className="mt-0 h-[calc(100%-40px)] overflow-auto">
                <MetricsChart
                  ref={metricsChartRef}
                  fetchOnMount={activeTab === MachineSubview.METRICS}
                  isPaused={
                    machineStatus?.node_provider_status === ExecutionEnvironmentStatus.PAUSED ||
                    machineStatus?.node_provider_status === ExecutionEnvironmentStatus.ERROR
                  }
                />
              </TabsContent>
            )}

            {/* Logs Tab - E2B only */}
            {computeNode?.node_provider_type === ComputeProviderType.E2B && (
              <TabsContent value={MachineSubview.LOGS} className="mt-0 h-[calc(100%-40px)] overflow-hidden">
                <LogsViewer
                  ref={logsViewerRef}
                  fetchOnMount={activeTab === MachineSubview.LOGS}
                  isPaused={
                    machineStatus?.node_provider_status === ExecutionEnvironmentStatus.PAUSED ||
                    machineStatus?.node_provider_status === ExecutionEnvironmentStatus.ERROR
                  }
                />
              </TabsContent>
            )}
          </Tabs>
        )}
      </div>
    </div>
  );
};
