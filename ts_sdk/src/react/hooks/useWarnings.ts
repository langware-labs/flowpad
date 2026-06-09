import {
  cloudManager,
  createCloudConnectionAuthRejectedWarning,
  createCloudConnectionLostWarning,
  createCloudDisconnectedWarning,
  createHubRequestFailedWarning,
  createNoComputeNodeWarning,
  createSnifferNotFoundWarning,
  dataContext,
  HubClientErrorInfo,
  UserWarning,
} from '../..';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useContext } from './useContext';

/**
 * Hook that manages user warnings based on current context state.
 * Automatically computes and updates warnings for:
 * - Cloud disconnected (in desktop mode when cloud login is not available)
 */
export function useWarnings() {
  const context = useContext();
  const {
    isDesktop,
    cloudLoginAvailable,
    computeNode,
    snifferEnabled,
    cloudConnectionStatus,
  } = context;

  // Track the most recent hub HTTP error (4xx/5xx) reported by the local
  // backend's httpx hook. Shown as a soft warning so the user can see the
  // full method/path/status and copy it; clicking dismisses it.
  const [lastHubError, setLastHubError] = useState<HubClientErrorInfo | null>(
    () => cloudManager.lastHubError,
  );
  useEffect(() => {
    const handler = (next: HubClientErrorInfo | null) => setLastHubError(next);
    cloudManager.on('last_hub_error_changed', handler);
    setLastHubError(cloudManager.lastHubError);
    return () => {
      cloudManager.off('last_hub_error_changed', handler);
    };
  }, []);

  // Compute warnings based on current state
  const computedWarnings = useMemo(() => {
    const warnings: UserWarning[] = [];

    // Only show warnings in desktop mode
    if (!isDesktop) {
      return warnings;
    }

    // Cloud disconnected warning — fires when LOGGED_OUT.
    if (!cloudLoginAvailable) {
      warnings.push(createCloudDisconnectedWarning());
    } else if (cloudConnectionStatus === 'auth_rejected') {
      // Logged in but the hub WS turned us away — distinct from "logged out".
      warnings.push(createCloudConnectionAuthRejectedWarning());
    } else if (cloudConnectionStatus === 'error' || cloudConnectionStatus === 'disconnected') {
      // Logged in but the WS bridge is down. Realtime sharing paused.
      warnings.push(createCloudConnectionLostWarning());
    }

    // Most recent hub HTTP error — request-level failure, NOT a connection
    // problem. Distinct from the connection warnings above; both can be
    // present at once (e.g. WS reconnecting + an in-flight fs/download
    // returned 404).
    if (lastHubError) {
      warnings.push(createHubRequestFailedWarning({
        method: lastHubError.method,
        path: lastHubError.path,
        statusCode: lastHubError.statusCode,
        message: lastHubError.message,
        onDismiss: () => cloudManager.clearLastHubError(),
      }));
    }

    // No compute node warning
    if (!computeNode) {
      warnings.push(createNoComputeNodeWarning());
    }

    // Sniffer enabled but hook entity not found (pre-bootstrap race or creation failure)
    if (snifferEnabled && !dataContext.snifferHook) {
      warnings.push(createSnifferNotFoundWarning());
    }

    return warnings;
  }, [isDesktop, cloudLoginAvailable, cloudConnectionStatus, computeNode, snifferEnabled, lastHubError]);

  // Update context warnings when computed warnings change
  useEffect(() => {
    dataContext.setWarnings(computedWarnings);
  }, [computedWarnings]);

  // Helper to remove a specific warning
  const dismissWarning = useCallback((warningId: string) => {
    dataContext.removeWarning(warningId);
  }, []);

  return {
    warnings: context.warnings,
    dismissWarning,
  };
}
