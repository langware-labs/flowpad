import { useAgentContext } from '@src/contexts/agent-context';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { useCurrentArtifacts } from '@src/hooks/flow-hooks';
import {
  Artifact,
  ArtifactType,
  dataManager,
  MachineStatus,
  MachineStatusUtils,
  ServiceStatusEnum,
  ServicesStatus,
  ActionInfo,
} from '@sdk';
import { Hammer, Loader2, Play, Square } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

type ActionState = 'idle' | 'starting' | 'stopping' | 'error';

interface ServiceStatusLedProps {
  className?: string;
  onShowShell?: () => void;
  onRefreshWebapp?: () => void;
  onStatusChange?: (status: MachineStatus) => void;
}

export const ServiceStatusLed: React.FC<ServiceStatusLedProps> = ({ className = '', onShowShell, onRefreshWebapp, onStatusChange }) => {
  const { flow, computeNode } = useAgentContext();
  const { data: artifacts = [] } = useCurrentArtifacts();
  const { t } = useLingui();
  const [machineStatus, setMachineStatus] = useState<MachineStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [actionState, setActionState] = useState<ActionState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const refreshDebounceRef = useRef<NodeJS.Timeout | null>(null);

  const fetchMachineStatus = useCallback(async () => {
    if (!computeNode?.id) return;

    setIsLoading(true);

    try {
      const actionInfo = new ActionInfo('get-machine-status', 'compute_node', computeNode.id, 'GET');
      const response = await fetch(actionInfo.fullActionUrl, {
        credentials: 'include',
      });

      if (!response.ok) {
        return;
      }

      const data = await response.json();
      if (data.data) {
        setMachineStatus(data.data);
        onStatusChange?.(data.data);
      }
    } catch (err) {
      console.error('[ServiceStatusLed] fetchMachineStatus error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [computeNode?.id, onStatusChange]);

  // Debounced refresh function - refreshes both machine status and webapp iframe
  const debouncedRefresh = useCallback(() => {
    // Clear any existing debounce timer
    if (refreshDebounceRef.current) {
      clearTimeout(refreshDebounceRef.current);
    }

    // Set new debounce timer (1 second)
    refreshDebounceRef.current = setTimeout(() => {
      void fetchMachineStatus();
      onRefreshWebapp?.();
      refreshDebounceRef.current = null;
    }, 1000);
  }, [fetchMachineStatus, onRefreshWebapp]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (refreshDebounceRef.current) {
        clearTimeout(refreshDebounceRef.current);
      }
    };
  }, []);

  // Fetch machine status on mount and when flow changes
  useEffect(() => {
    void fetchMachineStatus();
  }, [fetchMachineStatus]);

  // Poll for status updates every 5 seconds, paused when tab is hidden
  useEffect(() => {
    const poll = () => void fetchMachineStatus();
    let id = setInterval(poll, 5000);

    const onVisibility = () => {
      if (document.hidden) {
        clearInterval(id);
      } else {
        poll();
        id = setInterval(poll, 5000);
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchMachineStatus]);

  const servicesStatus: ServicesStatus | null = useMemo(() => {
    if (!machineStatus || artifacts.length === 0) return null;
    return MachineStatusUtils.getServiceStatus(machineStatus, artifacts);
  }, [machineStatus, artifacts]);

  // Get service artifacts (WEBAPP and APP_SERVICE with ports)
  const serviceArtifacts = useMemo(() => {
    return artifacts.filter(
      (a): a is Artifact =>
        (a.artifact_type === ArtifactType.WEBAPP || a.artifact_type === ArtifactType.APP_SERVICE) && a.port != null,
    );
  }, [artifacts]);

  // Stop all services via shell manager
  const handleStopServices = useCallback(async () => {
    if (!computeNode || serviceArtifacts.length === 0) return;

    // Show shell when stopping
    onShowShell?.();

    setActionState('stopping');
    setErrorMessage(null);

    try {
      for (const artifact of serviceArtifacts) {
        const port = artifact.port;
        // Kill process on port - lsof works on both macOS and Linux
        const stopCmd = `kill $(lsof -t -i:${port}) 2>/dev/null || echo "No process on port ${port}"`;
        { const action = new ActionInfo('terminal-command', 'compute_node', computeNode.id, 'POST'); action.bodyParameters = { command: stopCmd }; await dataManager.callAction(action); }
      }

      // Wait a moment for processes to terminate
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Trigger debounced refresh (machine status + webapp iframe)
      debouncedRefresh();
    } catch (err) {
      console.error('[ServiceStatusLed] handleStopServices error:', err);
      setErrorMessage(err instanceof Error ? err.message : t`Failed to stop services`);
    } finally {
      // Always reset action state to allow user to retry
      setActionState('idle');
    }
  }, [computeNode, serviceArtifacts, debouncedRefresh, onShowShell]);

  // Start all services via shell manager
  const handleStartServices = useCallback(async () => {
    console.log('[ServiceStatusLed] handleStartServices called', {
      computeNode: computeNode?.id,
      serviceArtifactsCount: serviceArtifacts.length,
      artifacts: serviceArtifacts.map((a) => ({ name: a.name, port: a.port, start_cmd: a.start_cmd })),
    });

    if (!computeNode || serviceArtifacts.length === 0) {
      console.log('[ServiceStatusLed] Early return - no computeNode or no serviceArtifacts');
      return;
    }

    // Show shell when starting
    onShowShell?.();

    setActionState('starting');
    setErrorMessage(null);

    try {
      for (const artifact of serviceArtifacts) {
        const metadata = artifact.metadata;
        // Check both start_cmd and start-cmd (hyphenated) keys
        const startCmd = artifact.start_cmd || metadata?.start_cmd || metadata?.['start-cmd'];
        console.log('[ServiceStatusLed] Processing artifact', {
          name: artifact.name,
          port: artifact.port,
          start_cmd: artifact.start_cmd,
          metadata_start_cmd: metadata?.start_cmd,
          metadata_start_hyphen_cmd: metadata?.['start-cmd'],
          resolvedStartCmd: startCmd,
        });

        if (!startCmd) {
          throw new Error(`Service ${artifact.name || artifact.port} has no start command`);
        }

        // Run start command in background using bash -c to handle && properly with nohup
        const escapedCmd = (startCmd as string).replace(/'/g, "'\\''");
        const fullCmd = `nohup bash -c '${escapedCmd}' > /tmp/service_${artifact.port}.log 2>&1 &`;
        console.log('[ServiceStatusLed] Executing command:', fullCmd);
        { const action = new ActionInfo('terminal-command', 'compute_node', computeNode.id, 'POST'); action.bodyParameters = { command: fullCmd }; await dataManager.callAction(action); }
        console.log('[ServiceStatusLed] Command executed successfully');
      }

      // Wait for services to start
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Trigger debounced refresh (machine status + webapp iframe)
      debouncedRefresh();
    } catch (err) {
      console.error('[ServiceStatusLed] Error starting services:', err);
      setErrorMessage(err instanceof Error ? err.message : t`Failed to start services`);
    } finally {
      // Always reset action state to allow user to retry
      setActionState('idle');
    }
  }, [computeNode, serviceArtifacts, debouncedRefresh, onShowShell]);

  // Restart services (used after error) via shell manager
  const handleRestartServices = useCallback(async () => {
    if (!computeNode || serviceArtifacts.length === 0) return;

    // Show shell when restarting
    onShowShell?.();

    setActionState('starting');
    setErrorMessage(null);

    try {
      for (const artifact of serviceArtifacts) {
        const port = artifact.port;

        // Stop first - lsof works on both macOS and Linux
        const stopCmd = `kill $(lsof -t -i:${port}) 2>/dev/null || echo "No process on port ${port}"`;
        { const action = new ActionInfo('terminal-command', 'compute_node', computeNode.id, 'POST'); action.bodyParameters = { command: stopCmd }; await dataManager.callAction(action); }
      }

      // Wait for processes to terminate
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Start all services
      for (const artifact of serviceArtifacts) {
        const metadata = artifact.metadata;
        // Check both start_cmd and start-cmd (hyphenated) keys
        const startCmd = artifact.start_cmd || metadata?.start_cmd || metadata?.['start-cmd'];
        if (!startCmd || typeof startCmd !== 'string') {
          throw new Error(`Service ${artifact.name || artifact.port} has no start command`);
        }

        // Run start command in background using bash -c to handle && properly with nohup
        const escapedCmd = startCmd.replace(/'/g, "'\\''");
        const fullCmd = `nohup bash -c '${escapedCmd}' > /tmp/service_${artifact.port}.log 2>&1 &`;
        { const action = new ActionInfo('terminal-command', 'compute_node', computeNode.id, 'POST'); action.bodyParameters = { command: fullCmd }; await dataManager.callAction(action); }
      }

      // Wait for services to start
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Trigger debounced refresh (machine status + webapp iframe)
      debouncedRefresh();
    } catch (err) {
      console.error('[ServiceStatusLed] Error restarting services:', err);
      setErrorMessage(err instanceof Error ? err.message : t`Failed to restart services`);
    } finally {
      // Always reset action state to allow user to retry
      setActionState('idle');
    }
  }, [computeNode, serviceArtifacts, debouncedRefresh, onShowShell]);

  const tooltipTitle = useMemo(() => {
    if (isLoading) return t`Checking service status...`;
    if (actionState === 'error') return t`Service error`;
    if (!servicesStatus) {
      // No machine status but we have service artifacts - show unknown status
      return serviceArtifacts.length > 0 ? t`Service status unknown` : t`No services to monitor`;
    }
    if (servicesStatus.services.length === 0) return t`No services with ports found`;
    if (servicesStatus.allRunning) return t`All services running`;
    return t`Some services stopped`;
  }, [isLoading, servicesStatus, actionState, serviceArtifacts.length]);

  const ledColor = useMemo(() => {
    if (actionState === 'error') return 'bg-red-500';
    if (isLoading || actionState === 'starting' || actionState === 'stopping') return 'bg-yellow-400';
    if (!servicesStatus) {
      // No machine status - gray if we have service artifacts (unknown), gray if none
      return 'bg-gray-400';
    }
    if (servicesStatus.services.length === 0) return 'bg-gray-400';
    if (servicesStatus.allRunning) return 'bg-green-500';
    return 'bg-red-500';
  }, [isLoading, servicesStatus, actionState]);

  const pulseClass = useMemo(() => {
    if (isLoading || actionState === 'starting' || actionState === 'stopping') return 'animate-pulse';
    if (servicesStatus?.allRunning) return '';
    if (servicesStatus && servicesStatus.missingServices.length > 0) return 'animate-pulse';
    return '';
  }, [isLoading, servicesStatus, actionState]);

  const isActionInProgress = actionState === 'starting' || actionState === 'stopping';

  // Don't render if no services with ports exist
  // Use serviceArtifacts instead of servicesStatus to allow rendering even when machineStatus is unavailable
  if (!isLoading && serviceArtifacts.length === 0) {
    return null;
  }

  // When machineStatus is unavailable but we have service artifacts, assume services are stopped
  // Show play button if: we have service artifacts AND (no status info OR not all services are running)
  const canStartServices = serviceArtifacts.length > 0 && (!servicesStatus || !servicesStatus.allRunning);

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      {/* LED indicator */}
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={`h-2.5 w-2.5 rounded-full ${ledColor} ${pulseClass} cursor-default`}
              aria-label={tooltipTitle}
            />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs bg-popover text-popover-foreground">
            <p className="text-xs font-medium">{tooltipTitle}</p>
            {servicesStatus && servicesStatus.services.length > 0 && (
              <div className="mt-1.5 space-y-1">
                {servicesStatus.services.map((s, idx) => {
                  const isRunning = s.status === ServiceStatusEnum.RUNNING;
                  return (
                    <div key={idx} className="flex items-center gap-2 text-xs">
                      <span className={`h-1.5 w-1.5 rounded-full ${isRunning ? 'bg-green-500' : 'bg-red-500'}`} />
                      <span className="flex-1">{s.artifact.name || `Port ${s.port}`}</span>
                      <span className={`${isRunning ? 'text-green-600' : 'text-red-500'}`}>
                        {isRunning ? <Trans>running</Trans> : <Trans>stopped</Trans>}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {actionState === 'error' && errorMessage && <p className="mt-1.5 text-xs text-red-500">{errorMessage}</p>}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/* Action buttons */}
      <TooltipProvider delayDuration={300}>
        {/* Error state - show restart (hammer) button */}
        {actionState === 'error' && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => void handleRestartServices()}
                disabled={isActionInProgress}
              >
                <Hammer className="h-3.5 w-3.5 text-red-500" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs bg-destructive text-destructive-foreground">
              <p className="text-xs font-medium"><Trans>Error: {errorMessage}</Trans></p>
              <p className="text-xs opacity-90"><Trans>Click to retry</Trans></p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Running state - show stop button */}
        {actionState !== 'error' && servicesStatus?.allRunning && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => void handleStopServices()}
                disabled={isActionInProgress}
              >
                {actionState === 'stopping' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Square className="h-3 w-3 fill-current" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="bg-popover text-popover-foreground">
              <p className="text-xs">{actionState === 'stopping' ? <Trans>Stopping...</Trans> : <Trans>Stop services</Trans>}</p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Stopped state - show start (play) button */}
        {actionState !== 'error' && canStartServices && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => void handleStartServices()}
                disabled={isActionInProgress}
              >
                {actionState === 'starting' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5 fill-current" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="bg-popover text-popover-foreground">
              <p className="text-xs">{actionState === 'starting' ? <Trans>Starting...</Trans> : <Trans>Start services</Trans>}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </TooltipProvider>
    </div>
  );
};
