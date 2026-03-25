import { ViewType } from './ViewType';

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
 * Create a warning for LLM not configured
 */
export function createLlmNotConfiguredWarning(): UserWarning {
  return {
    id: 'llm-not-configured',
    icon: 'AlertTriangle',
    color: 'yellow',
    message: 'LLM Not Configured',
    description: 'Configure your AI provider to enable agent functionality',
    targetView: ViewType.AI_CONFIG,
  };
}

/**
 * Create a warning for LLM disconnected
 */
export function createLlmDisconnectedWarning(): UserWarning {
  return {
    id: 'llm-disconnected',
    icon: 'X',
    color: 'red',
    message: 'LLM Disconnected',
    description: 'Your AI connection has been lost. Click to reconnect.',
    targetView: ViewType.AI_CONFIG,
  };
}

/**
 * Create a warning for cloud not connected
 */
export function createCloudDisconnectedWarning(): UserWarning {
  return {
    id: 'cloud-disconnected',
    icon: 'CloudOff',
    color: 'gray',
    message: 'Cloud Disconnected',
    description: 'Sharing, backup and download are blocked. Click to connect.',
    targetView: ViewType.CONNECTIONS,
  };
}

/**
 * Create a warning for no compute node in context
 */
export function createNoComputeNodeWarning(): UserWarning {
  return {
    id: 'no-compute-node',
    icon: 'AlertCircle',
    color: 'orange',
    message: 'No Compute Node',
    description: 'No compute environment is available. Shell and code execution are disabled.',
    targetView: ViewType.MACHINE,
  };
}
