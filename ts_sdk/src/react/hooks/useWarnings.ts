import { useRuntimeInfo } from './useRuntimeInfo';
import {
  createCloudConnectionAuthRejectedWarning,
  createCloudConnectionLostWarning,
  createCloudDisconnectedWarning,
  createHarnessLoginWarning,
  createHubRequestFailedWarning,
  createEmptyProjectsWarning,
  createProjectSetupRequiredWarning,
  createNoComputeNodeWarning,
  createNoHarnessWarning,
  SNIFFER_ACTIVE_WARNING,
  createSnifferNotFoundWarning,
  UserWarning,
} from '../../models/UserWarning';
import { dataContext } from '../../FlowSync/context';
import { cloudManager, type HubClientErrorInfo } from '../../services/cloud_login';
import { shouldWarnAboutEmptyProjects } from '../../stores/project-cleanup-store';
import { useCleanupSummary } from './use-cleanup-summary';
import { useProjectSetupLeft } from './use-project-readiness';
import { refreshProjectReadiness } from '../../stores/project-readiness-store';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useContext } from './useContext';
import { useLazyAsset } from './useLazyAsset';
import { LazyAsset } from '../../lazy/LazyAsset';
import { InstallState, type StatusRecord } from '../../entities/status-record';
import type { LLMFundingStatus } from '../../services/llm-sources-service';

/**
 * True when the status record lists CLI harnesses and none is installed. `unknown` (the boot
 * sweep has not finished) is not "not installed", so there is no false flash at startup.
 */
export function isNoHarnessFound(record: StatusRecord | null | undefined): boolean {
  const clis = (record?.harnesses ?? []).filter((h) => h.install !== InstallState.BuiltIn);
  return clis.length > 0 && clis.every((h) => h.install === InstallState.NotInstalled);
}

/**
 * Why the default harness has nothing to run on, or `null` when it is funded — the funding
 * layer's own set-up verdict. Only an installed default is asked: an uninstalled one is
 * `isNoHarnessFound`'s warning (or the default is simply wrong).
 */
export function defaultHarnessUnfunded(funding: LLMFundingStatus | null | undefined): string | null {
  const verdict = funding?.default;
  if (!verdict?.installed || verdict.source) return null;
  return verdict.reason || 'Nothing funds the default assistant.';
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
  // Checked in the background whenever the current project changes — the footer says when it
  // cannot run here yet.
  const projectId = context.project?.id ?? null;
  const projectName = context.project?.name ?? '';
  useEffect(() => {
    void refreshProjectReadiness(projectId);
  }, [projectId]);
  const setupLeft = useProjectSetupLeft(projectId);

  const cleanup = useCleanupSummary();
  const emptyProjects = shouldWarnAboutEmptyProjects(cleanup) ? cleanup!.empty_count : 0;

  // Status and funding, both pushed by the backend on change: the warnings re-read them and
  // derive nothing of their own.
  // Desktop only: the hub has no box to ask, and the warnings below are desktop-only anyway.
  const { data: statusRecord } = useLazyAsset(LazyAsset.Status, undefined, { enabled: isDesktop });
  const { data: funding } = useLazyAsset(
    LazyAsset.LlmFunding,
    { projectId: projectId ?? undefined },
    { enabled: isDesktop },
  );
  const noHarnessFound = isNoHarnessFound(statusRecord);
  const unfundedReason = defaultHarnessUnfunded(funding);

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

    if (noHarnessFound) {
      warnings.push(createNoHarnessWarning());
    }

    // The default assistant is installed and nothing pays for it — clicking opens the
    // Assistants & keys modal (routed by id in the warnings popover).
    if (!noHarnessFound && unfundedReason) {
      warnings.push(createHarnessLoginWarning(unfundedReason));
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

    if (setupLeft > 0) {
      warnings.push(createProjectSetupRequiredWarning(projectName, setupLeft));
    }

    return warnings;
  }, [
    setupLeft,
    projectName,
    emptyProjects,
    isDesktop,
    cloudLoginAvailable,
    cloudConnectionStatus,
    computeNode,
    snifferEnabled,
    snifferInstalled,
    lastHubError,
    noHarnessFound,
    unfundedReason,
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
