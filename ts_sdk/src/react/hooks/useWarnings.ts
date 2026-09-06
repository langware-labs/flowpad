import { useRuntimeInfo } from './useRuntimeInfo';
import {
  cloudManager,
  createCloudConnectionAuthRejectedWarning,
  createCloudConnectionLostWarning,
  createCloudDisconnectedWarning,
  createHarnessLoginWarning,
  createHubRequestFailedWarning,
  createEmptyProjectsWarning,
  createNoComputeNodeWarning,
  createNoHarnessWarning,
  SNIFFER_ACTIVE_WARNING,
  createSnifferNotFoundWarning,
  dataContext,
  HubClientErrorInfo,
  UserWarning,
} from '../..';
import { shouldWarnAboutEmptyProjects } from '../../stores/project-cleanup-store';
import { useCleanupSummary } from './use-cleanup-summary';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { HARNESS_CAPABILITY_KINDS, capabilityManager } from '../../capabilities';
import { useContext } from './useContext';

/**
 * True when every harness CLI is checked and none is installed. The
 * all-checked gate avoids a false flash while startup discovery is still
 * running.
 */
export function isNoHarnessFound(snapshots: ReadonlyArray<{ checked: boolean; available: boolean }>): boolean {
  return snapshots.every((snapshot) => snapshot.checked && !snapshot.available);
}

function readNoHarnessFound(): boolean {
  return isNoHarnessFound(HARNESS_CAPABILITY_KINDS.map((kind) => capabilityManager.getSnapshot(kind)));
}

/**
 * True when at least one harness CLI is installed, every installed one has a
 * probed login state (the startup gate populates it), and none is
 * authenticated. The probed-state gate avoids a false flash before the
 * auth-status probes land.
 */
export function isHarnessLoginRequired(
  snapshots: ReadonlyArray<{
    checked: boolean;
    available: boolean;
    capability: { login_state?: string | null } | null;
  }>,
): boolean {
  const installed = snapshots.filter((snapshot) => snapshot.checked && snapshot.available);
  return (
    installed.length > 0 &&
    installed.every((snapshot) => !!snapshot.capability?.login_state) &&
    !installed.some((snapshot) => snapshot.capability?.login_state === 'authenticated')
  );
}

function readHarnessLoginRequired(): boolean {
  return isHarnessLoginRequired(HARNESS_CAPABILITY_KINDS.map((kind) => capabilityManager.getSnapshot(kind)));
}

/**
 * Hook that manages user warnings based on current context state.
 * Automatically computes and updates warnings for:
 * - Cloud disconnected (in desktop mode when cloud login is not available)
 */
export function useWarnings() {
  useRuntimeInfo();
  const context = useContext();
  const { isDesktop, cloudLoginAvailable, computeNode, snifferEnabled, snifferInstalled, cloudConnectionStatus } =
    context;

  // Track the most recent hub HTTP error (4xx/5xx) reported by the local
  // backend's httpx hook. Shown as a soft warning so the user can see the
  // full method/path/status and copy it; clicking dismisses it.
  const [lastHubError, setLastHubError] = useState<HubClientErrorInfo | null>(() => cloudManager.lastHubError);
  useEffect(() => {
    const handler = (next: HubClientErrorInfo | null) => setLastHubError(next);
    cloudManager.on('last_hub_error_changed', handler);
    setLastHubError(cloudManager.lastHubError);
    return () => {
      cloudManager.off('last_hub_error_changed', handler);
    };
  }, []);

  // Empty-project count from the last project scan. The store only replaces its
  // held value on a real change, so an unchanged scan result does not rewrite
  // the global warnings context.
  const cleanup = useCleanupSummary();
  const emptyProjects = shouldWarnAboutEmptyProjects(cleanup) ? cleanup!.empty_count : 0;

  // Re-derive the no-harness verdict on capability events, but store the
  // boolean, not an event counter: setState with an unchanged value bails
  // out, so unrelated capability activity doesn't recompute the warning
  // list or rewrite the global warnings context.
  const [noHarnessFound, setNoHarnessFound] = useState(readNoHarnessFound);
  const [harnessLoginRequired, setHarnessLoginRequired] = useState(readHarnessLoginRequired);
  useEffect(
    () =>
      capabilityManager.subscribe(() => {
        setNoHarnessFound(readNoHarnessFound());
        setHarnessLoginRequired(readHarnessLoginRequired());
      }),
    [],
  );

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
      warnings.push(
        createHubRequestFailedWarning({
          method: lastHubError.method,
          path: lastHubError.path,
          statusCode: lastHubError.statusCode,
          message: lastHubError.message,
          onDismiss: () => cloudManager.clearLastHubError(),
        }),
      );
    }

    // No compute node warning
    if (!computeNode) {
      warnings.push(createNoComputeNodeWarning());
    }

    // No harness warning. HarnessCapabilitiesContext warms the checks at
    // app start; this only reads the snapshots.
    if (noHarnessFound) {
      warnings.push(createNoHarnessWarning());
    }

    // Harness(es) installed but none signed in — clicking opens the
    // harness-login modal (routed by id in the warnings popover).
    if (!noHarnessFound && harnessLoginRequired) {
      warnings.push(createHarnessLoginWarning());
    }

    // Sniffer hooks are live in the harness settings file — surface it for as
    // long as that holds, with a one-click way out. Keyed on what is installed
    // (not on the local entity) so a sniffer another instance wrote still shows.
    if (snifferInstalled) {
      warnings.push(SNIFFER_ACTIVE_WARNING);
    }

    // Sniffer enabled but hook entity not found (pre-bootstrap race or creation failure)
    if (snifferEnabled && !snifferInstalled && !dataContext.snifferHook) {
      warnings.push(createSnifferNotFoundWarning());
    }

    // Empty workspace folders piling up. Informational — the click opens the
    // cleanup screen, and nothing is removed until the user says so there.
    if (emptyProjects > 0) {
      warnings.push(createEmptyProjectsWarning(emptyProjects));
    }

    return warnings;
  }, [
    emptyProjects,
    isDesktop,
    cloudLoginAvailable,
    cloudConnectionStatus,
    computeNode,
    snifferEnabled,
    snifferInstalled,
    lastHubError,
    noHarnessFound,
    harnessLoginRequired,
  ]);

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
