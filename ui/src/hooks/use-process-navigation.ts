import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { useEditorStore } from '@src/store/use-editor-store';
import { useAuth } from '@sdk/react/hooks';
import { useCallback } from 'react';
import { useNavigate } from 'react-router';

/**
 * Custom hook for flow navigation actions (reused from chat-panel-header)
 * Provides handleNavigateToLanding and handleResetFlow functions
 */
export function useProcessNavigation() {
  const navigate = useNavigate();
  const { agent, flow, project } = useAgentContext();
  const { clearEditorContent } = useEditorStore();
  const { someone } = useAuth();

  const handleNavigateToLanding = useCallback((): void => {
    void navigate('/');
  }, [navigate]);

  const handleResetFlow = useCallback((): void => {
    if (!someone) {
      throw new Error('No one is logged in');
    }
    if (flow && !flow.saved) {
      console.warn('[useProcessNavigation] Current flow has unsaved changes. Cannot reset flow.');
      return;
    }
    if (!agent) {
      console.error('[useProcessNavigation] No agent found in context or dataContext');
      return;
    }
    if (!project) {
      console.error('[useProcessNavigation] No project found in context');
      return;
    }

    console.warn('[useProcessNavigation] project.createFlow is no longer supported; flow reset not available');
    clearEditorContent();
  }, [someone, flow, project, navigate, agent, clearEditorContent]);

  return {
    handleNavigateToLanding,
    handleResetFlow,
  };
}
