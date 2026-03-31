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
  /** Optional callback to execute when the warning is clicked (in addition to navigation) */
  onClick?: () => void;
}

/**
 * Warning IDs for built-in warnings
 */
export const WARNING_IDS = {
  LLM_NOT_CONFIGURED: 'llm-not-configured',
  LLM_DISCONNECTED: 'llm-disconnected',
  CLOUD_DISCONNECTED: 'cloud-disconnected',
  NO_COMPUTE_NODE: 'no-compute-node',
  SNIFFER_NOT_FOUND: 'sniffer-not-found',
} as const;

/**
 * Create a warning for LLM not configured
 */
export function createLlmNotConfiguredWarning(): UserWarning {
  return {
    id: WARNING_IDS.LLM_NOT_CONFIGURED,
    icon: 'AlertTriangle',
    color: 'yellow',
    message: 'LLM Not Configured',
    description: 'Configure your AI provider to enable agent functionality',
    targetView: ViewType.AI_CONFIG,
  };
}

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
        const { oauthService, OAUTH_PROVIDERS } = await import('../services/oauth/oauth-service');
        await oauthService.connect(OAUTH_PROVIDERS.FLOWPAD_CLOUD);
      } catch (e) {
        console.error('[Cloud Login] Failed to get login URL:', e);
      }
    },
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
