import { useAgentContext } from '@src/contexts/agent-context';
import { Flow, Project, QueryFilter, QueryRequest } from '@sdk';
import { useAuth, useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo } from 'react';

export const useProjectsHistory = () => {
  const { user } = useAuth();
  const { agent } = useAgentContext();

  const projectsRequest = useMemo(
    () =>
      new QueryRequest({
        type: Project.type,
        query: null,
        scope: [],
        name: 'useProjectsHistory-projects',
      }),
    [],
  );

  const { data: projects, isLoading: isProjectsLoading } = useEntitiesQuery<Project>(projectsRequest, {
    enabled: !!user,
  });

  const flowsQuery = useMemo(() => new QueryFilter({ expand: ['auth_scopes'] }), []);
  const flowsRequest = useMemo(
    () =>
      new QueryRequest({
        type: Flow.type,
        query: flowsQuery,
        scope: agent?.typeId ? [agent.typeId] : [],
        name: 'useProjectsHistory-flows',
      }),
    [flowsQuery, agent?.typeId],
  );

  const { data: agentFlows, isLoading: isFlowsLoading } = useEntitiesQuery<Flow>(flowsRequest, {
    enabled: !!user,
  });

  const isLoading = isProjectsLoading || isFlowsLoading;

  // Group flows by project and sort by updated_date
  const projectFlowsMap = useMemo(() => {
    const map = new Map<string, Flow[]>();
    projects?.forEach((project) => {
      const projectFlows = (agentFlows || []).filter(
        (flow) => flow.projectTypeId && project.typeId && flow.projectTypeId.equals(project.typeId),
      );
      // Sort flows by updated_date (most recent first)
      const sortedFlows = projectFlows.sort(Flow.compare('updated_date'));
      map.set(project.id || '', sortedFlows);
      project.name ||= projectFlows.find((flow) => flow.title)?.title;
    });
    return map;
  }, [projects, agentFlows]);

  const sortedAgentProjects = useMemo(() => {
    return projects
      ?.filter((project) => (projectFlowsMap.get(project.id) || []).length > 0)
      .sort(Project.compare('updated_date'));
  }, [projects, projectFlowsMap]);

  return { projects: sortedAgentProjects, projectFlowsMap, isLoading };
};
