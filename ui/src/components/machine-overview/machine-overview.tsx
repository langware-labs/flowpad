import { useAgentContext } from '@src/contexts/agent-context';
import {
  ActionInfo,
  ComputeProviderType,
  ExecutionEnvironmentStatus,
  MachineStatus,
  MachineSubview,
  ShellInputFlowData,
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
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle,
  Copy,
  FileText,
  Key,
  Network,
  Pause,
  Play,
  RefreshCw,
  Server,
  Settings,
  XCircle,
  Zap,
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
  if (direction === 'asc') return <ArrowUp className="ml-1 inline h-3 w-3" />;
  if (direction === 'desc') return <ArrowDown className="ml-1 inline h-3 w-3" />;
  return <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-30" />;
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

// Gateway tab types
interface ConfigStatus {
  apiKey: string | null;
  backendUrl: string | null;
  machineId: string | null;
}

type TestResult = 'idle' | 'loading' | 'success' | 'error';

export const MachineOverview: React.FC = () => {
  const { flow, computeNode } = useAgentContext();
  const { navigation, currentDock } = useDockNavigation();
  const { t } = useLingui();
  const [machineStatus, setMachineStatus] = useState<MachineStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processFilter, setProcessFilter] = useState('');
  const [networkFilter, setNetworkFilter] = useState('');
  const [processSort, setProcessSort] = useState<SortState<ProcessSortKey>>({ key: 'cpu_percent', direction: 'desc' });
  const [networkSort, setNetworkSort] = useState<SortState<NetworkSortKey>>({ key: 'port', direction: 'asc' });

  // Gateway tab state
  const [configStatus, setConfigStatus] = useState<ConfigStatus>({ apiKey: null, backendUrl: null, machineId: null });
  const [configLoading, setConfigLoading] = useState(false);
  const [healthTestResult, setHealthTestResult] = useState<TestResult>('idle');
  const [healthTestMessage, setHealthTestMessage] = useState<string | null>(null);
  const [apiTestResult, setApiTestResult] = useState<TestResult>('idle');
  const [apiTestMessage, setApiTestMessage] = useState<string | null>(null);
  const [lmTestResult, setLmTestResult] = useState<TestResult>('idle');
  const [lmTestMessage, setLmTestMessage] = useState<string | null>(null);
  const [setupLmProxyResult, setSetupLmProxyResult] = useState<TestResult>('idle');
  const [setupLmProxyMessage, setSetupLmProxyMessage] = useState<string | null>(null);

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

  // Helper function to execute command and accumulate stdout output
  const getCommandOutput = useCallback(
    async (command: string, sessionId: string): Promise<string> => {
      if (!computeNode) return '';

      const input = new ShellInputFlowData(command, sessionId);
      let output = '';
      let lastStdoutLength = 0;

      await computeNode.executeCommandStreaming(input, (progress) => {
        const stdout = progress.stdoutElement?.content ?? '';
        const stdoutDelta = progress.stdoutDelta ?? '';
        const stdoutLength = stdout.length;

        // Use delta instead of full content to avoid duplication
        if (stdoutDelta) {
          output += stdoutDelta;
        } else if (stdout && stdoutLength > lastStdoutLength) {
          // Fallback: use content if delta not available but content grew
          output += stdout.slice(lastStdoutLength);
        }
        lastStdoutLength = stdoutLength;
      });

      return output;
    },
    [computeNode],
  );

  // Gateway tab functions
  const fetchConfigFromMachine = useCallback(async () => {
    if (!computeNode) return;

    setConfigLoading(true);
    try {
      // Read environment variables directly from .bashrc (more reliable than sourcing)
      // The variables are stored as: export FLOWPAD_LM_PROXY_KEY='value'
      // Use grep to extract them, similar to how tests do it
      const grepCmd = `grep -E '^export FLOWPAD_(LM_PROXY_KEY|BACKEND_URL|MACHINE_ID)=' ~/.bashrc 2>/dev/null || echo ''`;
      const output = await getCommandOutput(grepCmd, 'gateway-config-fetch');

      // Parse the .bashrc export lines (format: export FLOWPAD_LM_PROXY_KEY='value')
      // Match the export statement format used by set_env
      const apiKeyMatch = output.match(/export FLOWPAD_LM_PROXY_KEY='([^']+)'/);
      const backendUrlMatch = output.match(/export FLOWPAD_BACKEND_URL='([^']+)'/);
      const machineIdMatch = output.match(/export FLOWPAD_MACHINE_ID='([^']+)'/);

      setConfigStatus({
        apiKey: apiKeyMatch ? apiKeyMatch[1].trim() : null,
        backendUrl: backendUrlMatch ? backendUrlMatch[1].trim() : null,
        machineId: machineIdMatch ? machineIdMatch[1].trim() : null,
      });
    } catch (err) {
      console.error('[MachineOverview] fetchConfigFromMachine error:', err);
    } finally {
      setConfigLoading(false);
    }
  }, [computeNode, getCommandOutput]);

  // Helper to check if URL is localhost
  const isLocalhostUrl = useCallback((url: string) => {
    return url.includes('localhost') || url.includes('127.0.0.1');
  }, []);

  // Helper to check if compute node is remote (not local machine)
  const isRemoteNode = useCallback(() => {
    return computeNode?.node_provider_type !== ComputeProviderType.LOCAL_MACHINE;
  }, [computeNode]);

  const testHealthEndpoint = useCallback(async () => {
    if (!computeNode || !configStatus.backendUrl) {
      setHealthTestMessage(t`Backend URL not configured`);
      setHealthTestResult('error');
      return;
    }

    setHealthTestResult('loading');
    setHealthTestMessage(null);

    try {
      const healthUrl = `${configStatus.backendUrl}/api/v1/health/status`;
      // If curl fails to connect, %{http_code} will be 000, so we use that as our sentinel value
      const curlCmd = `curl -s -o /dev/null -w "%{http_code}" "${healthUrl}" 2>/dev/null; [ $? -eq 0 ] || echo "000"`;
      const output = await getCommandOutput(curlCmd, 'health-test');

      // Normalize status code: when curl fails, -w "%{http_code}" outputs "000"
      // and || echo "000" adds another "000", resulting in "000000"
      // Extract first 3 digits or normalize multiple zeros to single "000"
      let statusCode = output.trim() || '000';
      if (statusCode.match(/^0+$/)) {
        statusCode = '000'; // Normalize any sequence of zeros to single "000"
      } else {
        statusCode = statusCode.slice(0, 3); // Take first 3 digits for valid HTTP codes
      }

      if (statusCode === '200') {
        setHealthTestResult('success');
        setHealthTestMessage(t`Health check passed (200 OK)`);
      } else if (statusCode === '000' && isLocalhostUrl(configStatus.backendUrl) && isRemoteNode()) {
        setHealthTestResult('error');
        setHealthTestMessage(
          t`Cannot reach localhost from remote sandbox. Use ngrok or a public URL to expose your backend.`,
        );
      } else if (statusCode === '000') {
        setHealthTestResult('error');
        setHealthTestMessage(t`Connection failed - server unreachable or not running`);
      } else {
        setHealthTestResult('error');
        setHealthTestMessage(t`Health check failed (HTTP ${statusCode})`);
      }
    } catch (err) {
      setHealthTestResult('error');
      setHealthTestMessage(err instanceof Error ? err.message : 'Failed to test health endpoint');
    }
  }, [computeNode, configStatus.backendUrl, isLocalhostUrl, isRemoteNode, getCommandOutput]);

  const testApiAccess = useCallback(async () => {
    if (!computeNode || !configStatus.apiKey || !configStatus.backendUrl || !configStatus.machineId) {
      setApiTestMessage(t`API Key, Backend URL, or Machine ID not configured`);
      setApiTestResult('error');
      return;
    }

    setApiTestResult('loading');
    setApiTestMessage(null);

    try {
      // Test API access by fetching the compute node's own data
      const apiUrl = `${configStatus.backendUrl}/api/v1/graph/compute_node/${computeNode.id}`;
      // Use --fail-with-body to ensure curl returns non-zero on HTTP errors, but still outputs status code
      // If curl fails to connect, %{http_code} will be 000, so we use that as our sentinel value
      const curlCmd = `curl -s -o /dev/null -w "%{http_code}" --fail-with-body -H "Authorization: Bearer ${configStatus.apiKey}" -H "X-Machine-ID: ${configStatus.machineId}" "${apiUrl}" 2>/dev/null || echo "000"`;
      const output = await getCommandOutput(curlCmd, 'api-test');

      // Normalize status code: when curl fails, -w "%{http_code}" outputs "000"
      // and || echo "000" adds another "000", resulting in "000000"
      // Extract first 3 digits or normalize multiple zeros to single "000"
      let statusCode = output.trim() || '000';
      if (statusCode.match(/^0+$/)) {
        statusCode = '000'; // Normalize any sequence of zeros to single "000"
      } else {
        statusCode = statusCode.slice(0, 3); // Take first 3 digits for valid HTTP codes
      }

      if (statusCode === '200') {
        setApiTestResult('success');
        setApiTestMessage(t`API access test passed (200 OK)`);
      } else if (statusCode === '000' && isLocalhostUrl(configStatus.backendUrl) && isRemoteNode()) {
        setApiTestResult('error');
        setApiTestMessage(
          t`Cannot reach localhost from remote sandbox. Use ngrok or a public URL to expose your backend.`,
        );
      } else if (statusCode === '000') {
        setApiTestResult('error');
        setApiTestMessage(t`Connection failed - server unreachable or not running`);
      } else if (statusCode === '401') {
        setApiTestResult('error');
        setApiTestMessage(t`API access denied (401 Unauthorized) - check API key and Machine ID`);
      } else if (statusCode === '403') {
        setApiTestResult('error');
        setApiTestMessage(t`API access forbidden (403) - Machine ID may not be whitelisted for this API key`);
      } else if (statusCode === '422') {
        setApiTestResult('error');
        setApiTestMessage(t`Validation error (422) - request format issue or entity not found`);
      } else {
        setApiTestResult('error');
        setApiTestMessage(t`API access test failed (HTTP ${statusCode})`);
      }
    } catch (err) {
      setApiTestResult('error');
      setApiTestMessage(err instanceof Error ? err.message : 'Failed to test API access');
    }
  }, [computeNode, configStatus, isLocalhostUrl, isRemoteNode, getCommandOutput]);

  const testLm = useCallback(async () => {
    if (!computeNode || !configStatus.apiKey || !configStatus.backendUrl || !configStatus.machineId) {
      setLmTestMessage(t`API Key, Backend URL, or Machine ID not configured`);
      setLmTestResult('error');
      return;
    }

    setLmTestResult('loading');
    setLmTestMessage(null);

    try {
      // Test LM proxy by sending a simple prompt to Anthropic via the proxy
      // Use compute_node target so API key authorization works
      // Use explicit provider prefix for clarity: /lm-proxy/anthropic/v1/messages
      const lmProxyUrl = `${configStatus.backendUrl}/api/v1/graph/compute_node/${computeNode.id}/lm-proxy/anthropic/v1/messages`;
      const requestBody = JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'Say hi' }],
      });

      // Use curl to make the request from the compute node
      // If curl fails to connect, %{http_code} will be 000, so we use that as our sentinel value
      const curlCmd = `curl -s -w "\\n__HTTP_CODE__:%{http_code}" -X POST "${lmProxyUrl}" \
         -H "Authorization: Bearer ${configStatus.apiKey}" \
         -H "X-Machine-ID: ${configStatus.machineId}" \
         -H "Content-Type: application/json" \
         -d '${requestBody.replace(/'/g, "'\\''")}' 2>/dev/null; [ $? -eq 0 ] || echo "__HTTP_CODE__:000"`;
      const output = await getCommandOutput(curlCmd, 'lm-test');

      // Parse status code from output
      const statusMatch = output.match(/__HTTP_CODE__:(\d+)/);
      const statusCode = statusMatch ? statusMatch[1] : '000';
      const responseBody = output.replace(/__HTTP_CODE__:\d+/, '').trim();

      if (statusCode === '200') {
        // Try to extract the LLM response text
        try {
          const jsonResponse = JSON.parse(responseBody);
          const text = jsonResponse.content?.[0]?.text || 'Response received';
          setLmTestResult('success');
          setLmTestMessage(
            `LM test passed (200 OK) - Response: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`,
          );
        } catch {
          setLmTestResult('success');
          setLmTestMessage(t`LM test passed (200 OK)`);
        }
      } else if (statusCode === '000' && isLocalhostUrl(configStatus.backendUrl) && isRemoteNode()) {
        setLmTestResult('error');
        setLmTestMessage(
          t`Cannot reach localhost from remote sandbox. Use ngrok or a public URL to expose your backend.`,
        );
      } else if (statusCode === '000') {
        setLmTestResult('error');
        setLmTestMessage(t`Connection failed - server unreachable or not running`);
      } else if (statusCode === '401') {
        setLmTestResult('error');
        setLmTestMessage(t`LM proxy denied (401 Unauthorized) - check API key`);
      } else if (statusCode === '500') {
        setLmTestResult('error');
        setLmTestMessage(t`LM proxy error (500) - check server logs for API key configuration`);
      } else {
        setLmTestResult('error');
        setLmTestMessage(t`LM test failed (HTTP ${statusCode})`);
      }
    } catch (err) {
      setLmTestResult('error');
      setLmTestMessage(err instanceof Error ? err.message : 'Failed to test LM proxy');
    }
  }, [computeNode, configStatus, isLocalhostUrl, isRemoteNode, getCommandOutput]);

  const setupLmProxy = useCallback(async () => {
    if (!flow?.id || !computeNode) {
      setSetupLmProxyMessage(t`Flow or compute node not available`);
      setSetupLmProxyResult('error');
      return;
    }

    setSetupLmProxyResult('loading');
    setSetupLmProxyMessage(null);

    try {
      const actionInfo = new ActionInfo('ops/setup-lm-proxy', 'compute_node', computeNode.id, 'POST');
      const data = await dataManager.callAction<undefined, { message?: string }>(actionInfo);
      setSetupLmProxyResult('success');
      setSetupLmProxyMessage(data?.message || t`LM proxy access configured`);
      // Refresh config to show the new values
      await fetchConfigFromMachine();
    } catch (err) {
      setSetupLmProxyResult('error');
      setSetupLmProxyMessage(err instanceof Error ? err.message : 'Failed to setup LM proxy');
    }
  }, [flow?.id, computeNode, fetchConfigFromMachine]);

  // Fetch config when switching to gateway tab
  useEffect(() => {
    if (activeTab === MachineSubview.GATEWAY) {
      void fetchConfigFromMachine();
    }
  }, [activeTab, fetchConfigFromMachine]);

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
        case MachineSubview.GATEWAY:
          // Gateway tab refreshes its own config
          await fetchConfigFromMachine();
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
  }, [activeTab, fetchMachineStatus, fetchConfigFromMachine]);

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
                            className={`ml-1 ${
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
                    <span className="font-medium"><Trans>Compute Node ID:</Trans></span>{' '}
                    <span className="font-mono">{computeNode?.id || 'N/A'}</span>
                    {computeNode?.id && (
                      <button
                        onClick={handleCopyComputeNodeId}
                        className="ml-1 rounded p-0.5 hover:bg-muted"
                        title={t`Copy Compute Node ID`}
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  <div>
                    <span className="font-medium"><Trans>Provider:</Trans></span> {computeNode?.node_provider_type || 'N/A'}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="font-medium"><Trans>Provider ID:</Trans></span>{' '}
                    <span className="font-mono">{computeNode?.node_provider_id || 'N/A'}</span>
                    {computeNode?.node_provider_id && (
                      <button
                        onClick={handleCopyProviderId}
                        className="ml-1 rounded p-0.5 hover:bg-muted"
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
                          <span className="font-medium"><Trans>Size:</Trans></span>{' '}
                          {machineStatus.node_info.size === 'sm'
                            ? <Trans>Small</Trans>
                            : machineStatus.node_info.size === 'md'
                              ? <Trans>Medium</Trans>
                              : machineStatus.node_info.size === 'lg'
                                ? <Trans>Large</Trans>
                                : machineStatus.node_info.size}{' '}
                          ({machineStatus.node_info.cpu_count} <Trans>CPU</Trans>, {machineStatus.node_info.memory_gb}<Trans>GB</Trans>)
                          {machineStatus.node_info.template_version && (
                            <>
                              <br />
                              <span className="font-medium"><Trans>Template:</Trans></span> {machineStatus.node_info.template_version}
                            </>
                          )}
                        </div>
                      )}
                      <div className={machineStatus.node_info ? '' : 'border-t pt-1'}>
                        <span className="font-medium"><Trans>Status:</Trans></span>{' '}
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
                          <span className="font-medium"><Trans>Status:</Trans></span> {machineStatus.status_msg}
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
                      <span className="cursor-help border-r border-border pr-3">
                        {machineStatus.node_info.size === 'sm'
                          ? <Trans>Small</Trans>
                          : machineStatus.node_info.size === 'md'
                            ? <Trans>Medium</Trans>
                            : machineStatus.node_info.size === 'lg'
                              ? <Trans>Large</Trans>
                              : machineStatus.node_info.size}{' '}
                        ({machineStatus.node_info.cpu_count} <Trans>CPU</Trans>, {machineStatus.node_info.memory_gb}<Trans>GB</Trans>)
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">
                      <div className="space-y-1">
                        <div>
                          <span className="font-medium"><Trans>Size:</Trans></span>{' '}
                          {machineStatus.node_info.size === 'sm'
                            ? <Trans>Small</Trans>
                            : machineStatus.node_info.size === 'md'
                              ? <Trans>Medium</Trans>
                              : machineStatus.node_info.size === 'lg'
                                ? <Trans>Large</Trans>
                                : machineStatus.node_info.size}
                        </div>
                        <div>
                          <span className="font-medium"><Trans>CPU:</Trans></span> {machineStatus.node_info.cpu_count} cores
                        </div>
                        <div>
                          <span className="font-medium"><Trans>Memory:</Trans></span> {machineStatus.node_info.memory_gb} GB
                        </div>
                        <div>
                          <span className="font-medium"><Trans>OS:</Trans></span> {machineStatus.node_info.os_type}
                        </div>
                        {machineStatus.node_info.template_version && (
                          <div>
                            <span className="font-medium"><Trans>Template:</Trans></span> {machineStatus.node_info.template_version}
                          </div>
                        )}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              <span><Trans>CPU:</Trans> {machineStatus.cpu_percent.toFixed(1)}%</span>
              <span><Trans>RAM:</Trans> {machineStatus.memory_percent.toFixed(1)}%</span>
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
                      {machineStatus.node_provider_status === ExecutionEnvironmentStatus.PAUSED ? <Trans>Resume</Trans> : <Trans>Pause</Trans>}
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
                <p><Trans>Refresh</Trans></p>
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
                  <Server className="mr-1.5 h-3.5 w-3.5" />
                  Processes ({sortedProcesses.length}
                  {processFilter ? `/${machineStatus.processes.length}` : ''})
                </TabsTrigger>
                <TabsTrigger value={MachineSubview.NETWORK} className="h-7 text-xs">
                  <Network className="mr-1.5 h-3.5 w-3.5" />
                  Network ({sortedNetwork.length}
                  {networkFilter ? `/${machineStatus.network.length}` : ''})
                </TabsTrigger>
                <TabsTrigger value={MachineSubview.GATEWAY} className="h-7 text-xs">
                  <Settings className="mr-1.5 h-3.5 w-3.5" />
                  <Trans>Gateway</Trans>
                </TabsTrigger>
                {computeNode?.node_provider_type === ComputeProviderType.E2B && (
                  <>
                    <TabsTrigger value={MachineSubview.METRICS} className="h-7 text-xs">
                      <Activity className="mr-1.5 h-3.5 w-3.5" />
                      <Trans>Metrics</Trans>
                    </TabsTrigger>
                    <TabsTrigger value={MachineSubview.LOGS} className="h-7 text-xs">
                      <FileText className="mr-1.5 h-3.5 w-3.5" />
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
                      className="text-left"
                    />
                    <SortableHeader
                      label={t`Name`}
                      sortKey="name"
                      currentSort={processSort}
                      onSort={handleProcessSort}
                      className="text-left"
                    />
                    <SortableHeader
                      label={t`CPU %`}
                      sortKey="cpu_percent"
                      currentSort={processSort}
                      onSort={handleProcessSort}
                      className="text-right"
                    />
                    <SortableHeader
                      label={t`RAM (MB)`}
                      sortKey="memory_mb"
                      currentSort={processSort}
                      onSort={handleProcessSort}
                      className="text-right"
                    />
                    <SortableHeader
                      label={t`Status`}
                      sortKey="status"
                      currentSort={processSort}
                      onSort={handleProcessSort}
                      className="text-left"
                    />
                    <th className="px-2 py-1.5 text-left font-medium"><Trans>Path</Trans></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedProcesses.map((proc) => (
                    <tr key={proc.pid} className="border-b hover:bg-muted/30">
                      <td className="px-2 py-1 font-mono">{proc.pid}</td>
                      <td className="max-w-[150px] truncate px-2 py-1" title={proc.name}>
                        {proc.name}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">{proc.cpu_percent.toFixed(1)}</td>
                      <td className="px-2 py-1 text-right font-mono">{proc.memory_mb.toFixed(1)}</td>
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
                      className="text-left"
                    />
                    <SortableHeader
                      label={t`Type`}
                      sortKey="type"
                      currentSort={networkSort}
                      onSort={handleNetworkSort}
                      className="text-left"
                    />
                    <SortableHeader
                      label={t`PID`}
                      sortKey="pid"
                      currentSort={networkSort}
                      onSort={handleNetworkSort}
                      className="text-left"
                    />
                    <SortableHeader
                      label={t`Process`}
                      sortKey="process_name"
                      currentSort={networkSort}
                      onSort={handleNetworkSort}
                      className="text-left"
                    />
                    <SortableHeader
                      label={t`Status`}
                      sortKey="status"
                      currentSort={networkSort}
                      onSort={handleNetworkSort}
                      className="text-left"
                    />
                    <th className="px-2 py-1.5 text-left font-medium"><Trans>Path</Trans></th>
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

            <TabsContent value={MachineSubview.GATEWAY} className="mt-0 h-[calc(100%-40px)] overflow-auto p-4">
              <div className="space-y-6">
                {/* Setup LM Proxy Section - show prominently when not configured */}
                {!configStatus.apiKey && !configLoading && (
                  <div className="rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="flex items-center gap-2 text-sm font-semibold">
                          <Key className="h-4 w-4 text-yellow-600" />
                          <Trans>LM Proxy Access Not Configured</Trans>
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          <Trans>Setup machine-restricted API access for this compute node</Trans>
                        </p>
                      </div>
                      <Button
                        variant="default"
                        size="sm"
                        className="h-8"
                        onClick={() => void setupLmProxy()}
                        disabled={true}
                      >
                        {setupLmProxyResult === 'loading' ? (
                          <RefreshCw className="mr-1.5 h-4 w-4 animate-spin" />
                        ) : (
                          <Key className="mr-1.5 h-4 w-4" />
                        )}
                        <Trans>Setup LM Proxy Access</Trans>
                      </Button>
                    </div>
                    {setupLmProxyMessage && (
                      <div
                        className={`mt-2 flex items-center gap-2 text-xs ${
                          setupLmProxyResult === 'success' ? 'text-green-600' : 'text-red-600'
                        }`}
                      >
                        {setupLmProxyResult === 'success' ? (
                          <CheckCircle className="h-3 w-3" />
                        ) : (
                          <XCircle className="h-3 w-3" />
                        )}
                        {setupLmProxyMessage}
                      </div>
                    )}
                  </div>
                )}

                <div className="rounded-lg border bg-card p-4">
                  <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold">
                    <Key className="h-4 w-4" />
                    <Trans>FlowPad Server Status</Trans>
                  </h3>

                  <div className="space-y-4">
                    {/* API Key */}
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground"><Trans>API Key</Trans></label>
                      <div className="flex items-center gap-2 rounded border bg-muted/30 px-3 py-2">
                        <span className="flex-1 truncate font-mono text-xs">
                          {configStatus.apiKey ? `${configStatus.apiKey.slice(0, 20)}...` : <Trans>Not configured</Trans>}
                        </span>
                        {configStatus.apiKey ? (
                          <CheckCircle className="h-4 w-4 text-green-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )}
                      </div>
                    </div>

                    {/* Machine ID */}
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground"><Trans>Machine ID</Trans></label>
                      <div className="flex items-center gap-2 rounded border bg-muted/30 px-3 py-2">
                        <span className="flex-1 truncate font-mono text-xs">
                          {configStatus.machineId ? `${configStatus.machineId.slice(0, 20)}...` : <Trans>Not configured</Trans>}
                        </span>
                        {configStatus.machineId ? (
                          <CheckCircle className="h-4 w-4 text-green-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )}
                      </div>
                    </div>

                    {/* Backend URL */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-medium text-muted-foreground"><Trans>FlowPad Backend URL</Trans></label>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() => void testHealthEndpoint()}
                          disabled={healthTestResult === 'loading' || !configStatus.backendUrl}
                        >
                          {healthTestResult === 'loading' ? (
                            <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
                          ) : (
                            <Server className="mr-1 h-3 w-3" />
                          )}
                          <Trans>Test Service</Trans>
                        </Button>
                      </div>
                      <div className="flex items-center gap-2 rounded border bg-muted/30 px-3 py-2">
                        <span className="flex-1 truncate font-mono text-xs">
                          {configStatus.backendUrl || <Trans>Not configured</Trans>}
                        </span>
                        {configStatus.backendUrl ? (
                          <CheckCircle className="h-4 w-4 text-green-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )}
                      </div>
                      {healthTestMessage && (
                        <div
                          className={`flex items-center gap-2 text-xs ${
                            healthTestResult === 'success' ? 'text-green-600' : 'text-red-600'
                          }`}
                        >
                          {healthTestResult === 'success' ? (
                            <CheckCircle className="h-3 w-3" />
                          ) : (
                            <XCircle className="h-3 w-3" />
                          )}
                          {healthTestMessage}
                        </div>
                      )}
                    </div>

                    {/* Test API Access */}
                    <div className="space-y-2 border-t pt-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <label className="text-xs font-medium"><Trans>Test API Access</Trans></label>
                          <p className="text-xs text-muted-foreground">
                            <Trans>Verify the machine can authenticate with the FlowPad API</Trans>
                          </p>
                        </div>
                        <Button
                          variant="default"
                          size="sm"
                          className="h-7 px-3 text-xs"
                          onClick={() => void testApiAccess()}
                          disabled={
                            apiTestResult === 'loading' ||
                            !configStatus.apiKey ||
                            !configStatus.backendUrl ||
                            !configStatus.machineId
                          }
                        >
                          {apiTestResult === 'loading' ? (
                            <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
                          ) : (
                            <Key className="mr-1 h-3 w-3" />
                          )}
                          <Trans>Test API Access</Trans>
                        </Button>
                      </div>
                      {apiTestMessage && (
                        <div
                          className={`flex items-center gap-2 text-xs ${
                            apiTestResult === 'success' ? 'text-green-600' : 'text-red-600'
                          }`}
                        >
                          {apiTestResult === 'success' ? (
                            <CheckCircle className="h-3 w-3" />
                          ) : (
                            <XCircle className="h-3 w-3" />
                          )}
                          {apiTestMessage}
                        </div>
                      )}
                    </div>

                    {/* Test LM Proxy */}
                    <div className="space-y-2 border-t pt-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <label className="text-xs font-medium"><Trans>Test LM Proxy</Trans></label>
                          <p className="text-xs text-muted-foreground">
                            <Trans>Send a simple prompt to verify the LM proxy is working</Trans>
                          </p>
                        </div>
                        <Button
                          variant="default"
                          size="sm"
                          className="h-7 px-3 text-xs"
                          onClick={() => void testLm()}
                          disabled={
                            lmTestResult === 'loading' ||
                            !configStatus.apiKey ||
                            !configStatus.backendUrl ||
                            !configStatus.machineId
                          }
                        >
                          {lmTestResult === 'loading' ? (
                            <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
                          ) : (
                            <Zap className="mr-1 h-3 w-3" />
                          )}
                          <Trans>Test LM</Trans>
                        </Button>
                      </div>
                      {lmTestMessage && (
                        <div
                          className={`flex items-center gap-2 text-xs ${
                            lmTestResult === 'success' ? 'text-green-600' : 'text-red-600'
                          }`}
                        >
                          {lmTestResult === 'success' ? (
                            <CheckCircle className="h-3 w-3" />
                          ) : (
                            <XCircle className="h-3 w-3" />
                          )}
                          {lmTestMessage}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
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
