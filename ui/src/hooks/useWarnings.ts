import {
  ActionInfo,
  connectionManager,
  createCloudDisconnectedWarning,
  createLlmNotConfiguredWarning,
  createNoComputeNodeWarning,
  dataContext,
  dataManager,
  UserWarning,
} from '@sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { useContext } from './useContext';

/**
 * TypeScript interfaces for Claude Code auth status
 */
export interface OAuthInfo {
  subscription_type: string | null; // "max", "pro", "free"
  rate_limit_tier: string | null;
  scopes: string[];
  expires_at: number | null; // Unix timestamp (ms)
  is_expired: boolean;
}

export interface ApiKeyInfo {
  key_prefix: string; // "sk-ant-api01-***" (masked!)
  source: string; // "environment", "flowpad_user", "file"
}

export interface UserProfileInfo {
  email: string | null;
  account_uuid: string | null;
  organization_name: string | null;
  organization_uuid: string | null;
}

export type ClaudeCodeAuthMethod = 'oauth' | 'api_key' | 'none';

export interface ClaudeCodeAuthStatus {
  is_authenticated: boolean;
  auth_method: ClaudeCodeAuthMethod;
  oauth_info: OAuthInfo | null;
  api_key_info: ApiKeyInfo | null;
  user_profile: UserProfileInfo | null;
  credentials_source: string | null;
  error: string | null;
}

export interface LlmConfigResponse {
  is_configured: boolean;
  claude_code_auth: ClaudeCodeAuthStatus | null;
}

/**
 * Hook that manages user warnings based on current context state.
 * Automatically computes and updates warnings for:
 * - LLM not configured (missing ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN)
 * - Cloud disconnected (in desktop mode when cloud login is not available)
 */
export function useWarnings() {
  const context = useContext();
  const { isDesktop, cloudLoginAvailable, user, computeNode } = context;
  const queryClient = useQueryClient();

  const { data: llmConfigData, isLoading: isLlmConfigLoading, refetch: refetchLlmConfig } = useQuery({
    queryKey: ['is-llm-configured', user?.typeId?.toString()],
    queryFn: async (): Promise<LlmConfigResponse> => {
      if (!user?.typeId || !isDesktop) {
        return { is_configured: false, claude_code_auth: null };
      }
      try {
        const actionInfo = new ActionInfo('is-llm-configured', user.typeId.type, user.typeId.id, 'GET');
        const response = await dataManager.callAction<unknown, LlmConfigResponse>(actionInfo);
        return response || { is_configured: false, claude_code_auth: null };
      } catch (error) {
        console.error('[useWarnings] Error checking LLM configuration:', error);
        return { is_configured: false, claude_code_auth: null };
      }
    },
    enabled: !!user?.typeId && isDesktop,
    staleTime: Infinity, // Data never becomes stale - only refetch when query key changes
    refetchInterval: false, // Don't auto-refetch on an interval
    refetchOnWindowFocus: false, // Don't refetch when window regains focus
    refetchOnReconnect: false, // Don't refetch when network reconnects
  });

  // Listen for LLM config WebSocket updates
  useEffect(() => {
    if (!user?.typeId) return;

    const handleLlmConfigChange = (message: {
      is_configured: boolean;
      auth_method: string;
      auth_data?: ClaudeCodeAuthStatus;
    }) => {
      // The `on_llm_config_msg` channel is shared by several OAuth providers
      // (Anthropic loopback, GitHub device flow, etc.). Only Anthropic broadcasts
      // carry Claude-relevant auth_data and should update the Claude config cache.
      // Filtering here prevents a GitHub device-flow event (which carries
      // auth_method='github' and no auth_data) from wiping the cached Anthropic
      // claude_code_auth blob.
      if (
        message.auth_method !== 'oauth' &&
        message.auth_method !== 'api_key' &&
        message.auth_method !== 'none'
      ) {
        return;
      }
      // Update the query cache with the new auth status
      queryClient.setQueryData(['is-llm-configured', user.typeId?.toString()], {
        is_configured: message.is_configured,
        claude_code_auth: message.auth_data || null,
      });
    };

    connectionManager.on('on_llm_config_msg', handleLlmConfigChange);

    return () => {
      connectionManager.off('on_llm_config_msg', handleLlmConfigChange);
    };
  }, [user?.typeId, queryClient]);

  // Listen for auth-failure events to immediately mark LLM as not configured.
  // This handles the case where the agentic process fails auth but the file watcher
  // hasn't sent an update yet (e.g., credentials were already missing).
  useEffect(() => {
    if (!user?.typeId) return;

    const handleDesktopSetup = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: string }>).detail;
      if (detail?.reason === 'auth-failure') {
        queryClient.setQueryData(['is-llm-configured', user.typeId?.toString()], {
          is_configured: false,
          claude_code_auth: null,
        });
      }
    };

    window.addEventListener('open-desktop-setup', handleDesktopSetup);
    return () => {
      window.removeEventListener('open-desktop-setup', handleDesktopSetup);
    };
  }, [user?.typeId, queryClient]);

  const isLlmConfigured = llmConfigData?.is_configured ?? false;
  const claudeCodeAuth = llmConfigData?.claude_code_auth ?? null;
  const isOAuthConfigured = claudeCodeAuth?.auth_method === 'oauth';

  // Compute warnings based on current state
  const computedWarnings = useMemo(() => {
    const warnings: UserWarning[] = [];

    // Only show warnings in desktop mode
    if (!isDesktop) {
      return warnings;
    }

    // LLM not configured warning
    if (!isLlmConfigured) {
      const llmWarning: UserWarning = {
        ...createLlmNotConfiguredWarning(),
        onClick: () => {
          window.dispatchEvent(new CustomEvent('open-desktop-setup'));
        },
      };
      warnings.push(llmWarning);
    }

    // Cloud disconnected warning
    if (!cloudLoginAvailable) {
      warnings.push(createCloudDisconnectedWarning());
    }

    // No compute node warning
    if (!computeNode) {
      warnings.push(createNoComputeNodeWarning());
    }

    return warnings;
  }, [isDesktop, isLlmConfigured, cloudLoginAvailable, computeNode]);

  // Update context warnings when computed warnings change
  useEffect(() => {
    dataContext.setWarnings(computedWarnings);
  }, [computedWarnings]);

  // Helper to remove a specific warning
  const dismissWarning = useCallback((warningId: string) => {
    dataContext.removeWarning(warningId);
  }, []);

  const recheckLlmConfig = useCallback(() => {
    refetchLlmConfig();
  }, [refetchLlmConfig]);

  return {
    warnings: context.warnings,
    isLlmConfigured,
    isLlmConfigLoading,
    isOAuthConfigured,
    claudeCodeAuth,
    dismissWarning,
    recheckLlmConfig,
  };
}
