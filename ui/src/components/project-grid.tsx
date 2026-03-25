import { useProjectsHistory } from '@src/hooks/use-projects-history';
import { useEditorStore } from '@src/store/use-editor-store';
import { AgenticProcess, Project } from '@sdk';
import React, { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useAgentContext } from './agent-layout/agent-layout';
import { ProjectList } from './project-list';

/**
 * ProjectGrid - Displays projects with flows in the agent context
 *
 * This is a wrapper around ProjectList that provides:
 * - Agent-context-aware navigation (navigates to /agent/:id/flow/:id)
 * - Projects grouped with their flows via useProjectsHistory
 *
 * For contexts without agent (e.g., dock home), use ProjectList directly
 * with useProjects hook.
 */
export const ProjectGrid: React.FC = () => {
  const { agent } = useAgentContext();
  const navigate = useNavigate();
  const { projects, projectFlowsMap, isLoading } = useProjectsHistory();
  const { clearEditorContent } = useEditorStore();

  const handleProjectClick = useCallback(
    (project: Project) => {
      const projectFlows = projectFlowsMap.get(project.id || '') || [];
      if (projectFlows.length > 0 && agent) {
        // Navigate to the most recently updated flow
        const mostRecentFlow = projectFlows[0];
        void navigate(`/${agent.typeId.toUrlString()}/${mostRecentFlow.typeId.toUrlString()}`, { replace: true });
      }
    },
    [agent, navigate, projectFlowsMap],
  );

  const handleFlowClick = useCallback(
    (flow: AgenticProcess, event: React.MouseEvent) => {
      event.stopPropagation(); // Prevent project click when clicking on flow
      if (agent) {
        void navigate(`/${agent.typeId.toUrlString()}/${flow.typeId.toUrlString()}`, { replace: true });
        clearEditorContent();
      }
    },
    [agent, navigate, clearEditorContent],
  );

  return (
    <ProjectList
      projects={projects}
      projectFlowsMap={projectFlowsMap}
      isLoading={isLoading}
      onProjectClick={handleProjectClick}
      onFlowClick={handleFlowClick}
    />
  );
};
