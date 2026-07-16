import { ViewType } from '../utils/ui/view-types';

/**
 * Icon names available for warnings
 */
export type WarningIconName =
  | 'AlertTriangle'
  | 'AlertCircle'
  | 'AlertOctagon'
  | 'Info'
  | 'X'
  | 'CloudOff'
  | 'Wifi'
  | 'WifiOff'
  | 'Settings'
  | 'Key';

/**
 * Color variants for warnings
 */
export type WarningColor = 'yellow' | 'red' | 'orange' | 'blue' | 'gray';

/**
 * Represents a user-facing warning with navigation capability
 */
export interface UserWarning {
  /** Unique identifier for the warning */
  id: string;
  /** Icon to display for the warning */
  icon: WarningIconName;
  /** Color theme for the warning */
  color: WarningColor;
  /** Short message describing the warning */
  message: string;
  /** Optional longer description */
  description?: string;
  /** ViewType to navigate to when clicking the warning */
  targetView: ViewType;
  /** Optional pointer for the target view (e.g., file path, section) */
  targetPointer?: string;
  /** Optional wiki page title to open on click — used when no `onClick` is set */
  wikiPage?: string;
  /** Optional callback to execute when the warning is clicked (in addition to navigation) */
  onClick?: () => void;
}

/**
 * Warning IDs for built-in warnings
 */
export const WARNING_IDS = {
  CLOUD_DISCONNECTED: 'cloud-disconnected',
  CLOUD_LOGIN_FAILED: 'cloud-login-failed',
  CLOUD_CONNECTION_LOST: 'cloud-connection-lost',
  CLOUD_CONNECTION_AUTH_REJECTED: 'cloud-connection-auth-rejected',
  HUB_REQUEST_FAILED: 'hub-request-failed',
  NO_COMPUTE_NODE: 'no-compute-node',
  NO_HARNESS: 'no-harness',
  SNIFFER_NOT_FOUND: 'sniffer-not-found',
  SECRETS_NOT_ENABLED: 'secrets-not-enabled',
} as const;

/**
 * Create a warning for cloud not connected
 */
export function createCloudDisconnectedWarning(): UserWarning {
  return {
    id: WARNING_IDS.CLOUD_DISCONNECTED,
    icon: 'CloudOff',
    color: 'gray',
    message: 'Cloud Disconnected',
    description: 'Sharing, backup and download are blocked',
    targetView: ViewType.CONNECTIONS,
    onClick: async () => {
      try {
        const { cloudManager } = await import('../services/cloud_login');
        await cloudManager.login();
      } catch (e) {
        console.error('[Cloud Login] Failed:', e);
      }
    },
  };
}

/**
 * Create a warning for a failed cloud login attempt (rejected creds, timeout, network).
 * The description carries the cloud-side error message.
 */
export function createCloudLoginFailedWarning(description: string): UserWarning {
  return {
    id: WARNING_IDS.CLOUD_LOGIN_FAILED,
    icon: 'CloudOff',
    color: 'red',
    message: 'Cloud Login Failed',
    description,
    targetView: ViewType.CONNECTIONS,
  };
}

/**
 * Fires when login is OK but the hub WS connection has dropped — distinct
 * from cloud-disconnected (which means logged-out). Action: reconnect.
 */
export function createCloudConnectionLostWarning(description?: string): UserWarning {
  return {
    id: WARNING_IDS.CLOUD_CONNECTION_LOST,
    icon: 'CloudOff',
    color: 'yellow',
    message: 'Cloud Connection Lost',
    description: description ?? 'Sharing and realtime updates are paused.',
    targetView: ViewType.CONNECTIONS,
    onClick: async () => {
      try {
        const { cloudManager } = await import('../services/cloud_login');
        await cloudManager.connectHubWs();
      } catch (e) {
        console.error('[Cloud Reconnect] Failed:', e);
      }
    },
  };
}

/**
 * Specialised variant of "connection lost" for the auth-rejected case — the
 * hub explicitly turned us away at the WS layer. Action: try reconnect (the
 * underlying bug may still be there, but at least the user can retry).
 */
export function createCloudConnectionAuthRejectedWarning(description?: string): UserWarning {
  return {
    id: WARNING_IDS.CLOUD_CONNECTION_AUTH_REJECTED,
    icon: 'CloudOff',
    color: 'red',
    message: 'Hub Rejected Connection',
    description: description ?? 'The hub refused this client. Try reconnect.',
    targetView: ViewType.CONNECTIONS,
    onClick: async () => {
      try {
        const { cloudManager } = await import('../services/cloud_login');
        await cloudManager.connectHubWs();
      } catch (e) {
        console.error('[Cloud Reconnect] Failed:', e);
      }
    },
  };
}

/**
 * Soft warning for a failed hub HTTP call (e.g. fs/download 404, a 5xx from
 * a hub action). Distinct from CLOUD_CONNECTION_LOST — the WS may be fine;
 * a single request just failed. The description carries the full
 * `METHOD path STATUS: message` so the copy button on the warning item
 * yields a useful, copyable detail line.
 */
export function createHubRequestFailedWarning(detail: {
  method: string;
  path: string;
  statusCode: number;
  message: string;
  onDismiss?: () => void;
}): UserWarning {
  const { method, path, statusCode, message, onDismiss } = detail;
  return {
    id: WARNING_IDS.HUB_REQUEST_FAILED,
    icon: 'CloudOff',
    color: 'orange',
    message: 'Cloud Request Failed',
    description: `${method} ${path} ${statusCode}: ${message}`.trim(),
    targetView: ViewType.CONNECTIONS,
    onClick: onDismiss,
  };
}

/**
 * Create a warning for no compute node in context
 */
export function createNoComputeNodeWarning(): UserWarning {
  return {
    id: WARNING_IDS.NO_COMPUTE_NODE,
    icon: 'AlertCircle',
    color: 'orange',
    message: 'No Compute Node',
    description: 'No compute environment is available. Shell and code execution are disabled.',
    targetView: ViewType.MACHINE,
  };
}

/**
 * Create a warning for no installed harness (coding agent CLI). Clicking it
 * opens the shipped "Install a harness" wiki page with per-harness install
 * instructions.
 */
export function createNoHarnessWarning(): UserWarning {
  return {
    id: WARNING_IDS.NO_HARNESS,
    icon: 'AlertCircle',
    color: 'orange',
    message: 'No harness found',
    description: 'Install a coding agent CLI (Claude, Codex or Copilot) to run agents. Click for setup instructions.',
    targetView: ViewType.CAPABILITIES,
    wikiPage: 'Install a harness',
  };
}

/**
 * Create a warning shown when the OS keychain access for app-secrets has
 * not been approved yet. Clicking it opens the SecretApprovalDialog via
 * `secretApprovalGate.request()`.
 */
export function createSecretsNotEnabledWarning(): UserWarning {
  return {
    id: WARNING_IDS.SECRETS_NOT_ENABLED,
    icon: 'Key',
    color: 'yellow',
    message: 'Keychain access not enabled',
    description: 'Approve OS keychain access so Flowpad can store login tokens and app secrets.',
    targetView: ViewType.AI_CONFIG,
  };
}

/**
 * Create a warning for sniffer hook not found
 */
export function createSnifferNotFoundWarning(): UserWarning {
  return {
    id: WARNING_IDS.SNIFFER_NOT_FOUND,
    icon: 'AlertTriangle',
    color: 'yellow',
    message: 'Sniffer Not Ready',
    description: 'Hook sniffer is enabled but the hook entity was not found. Try reloading.',
    targetView: ViewType.HOOKS,
  };
}
