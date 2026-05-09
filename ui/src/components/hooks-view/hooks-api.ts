import { getApiClient } from '@sdk';

export interface HookDefinition {
  type: 'command' | 'prompt';
  command?: string;
  prompt?: string;
  timeout?: number;
}

export interface HookEventConfig {
  matcher?: string;
  hooks: HookDefinition[];
}

export interface HookConfig {
  hooks: {
    [eventName: string]: HookEventConfig[];
  };
}

export interface HooksResponse {
  hooks: {
    [eventName: string]: HookEventConfig[];
  };
  settings_file?: string;
  exists?: boolean;
}

const apiClient = getApiClient();

let inFlightGetHooks: Promise<HooksResponse> | null = null;

/**
 * Get all hooks configuration.
 * Concurrent callers share the in-flight request to avoid duplicate GETs
 * (e.g. StrictMode double-invoke of the HooksView mount effect).
 */
export async function getHooks(): Promise<HooksResponse> {
  if (inFlightGetHooks) return inFlightGetHooks;
  inFlightGetHooks = (async () => {
    try {
      const response = await apiClient.get<HooksResponse>('/api/hooks');
      return response as unknown as HooksResponse;
    } finally {
      inFlightGetHooks = null;
    }
  })();
  return inFlightGetHooks;
}

/**
 * Update entire hooks configuration
 */
export async function updateHooks(config: HookConfig): Promise<{ success: boolean; hooks: HookConfig['hooks'] }> {
  const response = await apiClient.put<{ success: boolean; hooks: HookConfig['hooks'] }>('/api/hooks', config);
  return response as unknown as { success: boolean; hooks: HookConfig['hooks'] };
}

/**
 * Add a hook to a specific event
 */
export async function addHookToEvent(
  eventName: string,
  matcher: string | undefined,
  hook: HookDefinition,
): Promise<{ success: boolean; hooks: HookConfig['hooks'] }> {
  const response = await apiClient.post<{ success: boolean; hooks: HookConfig['hooks'] }>('/api/hooks/event', {
    eventName,
    matcher,
    hook,
  });
  return response as unknown as { success: boolean; hooks: HookConfig['hooks'] };
}

/**
 * Delete all hooks for a specific event
 */
export async function deleteEventHooks(eventName: string): Promise<{ success: boolean; hooks: HookConfig['hooks'] }> {
  const response = await apiClient.delete<{ success: boolean; hooks: HookConfig['hooks'] }>(
    `/api/hooks/event/${eventName}`,
  );
  return response as unknown as { success: boolean; hooks: HookConfig['hooks'] };
}
