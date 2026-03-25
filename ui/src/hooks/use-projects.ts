import { Project, QueryRequest } from '@sdk';
import { useAuth, useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo } from 'react';

/**
 * Hook to fetch user's projects without requiring agent context.
 * Use this when you need to display projects in a context-agnostic way (e.g., dock home).
 *
 * For projects WITH flows grouped by project, use useProjectsHistory instead.
 */
export const useProjects = () => {
  const { user } = useAuth();

  const projectsRequest = useMemo(
    () =>
      new QueryRequest({
        type: Project.type,
        query: null,
        scope: [],
        name: 'useProjects-projects',
      }),
    [],
  );

  const {
    data: projects,
    isLoading,
    refetch,
  } = useEntitiesQuery<Project>(projectsRequest, {
    enabled: !!user,
  });

  const sortedProjects = useMemo(() => {
    return projects?.slice().sort(Project.compare('updated_date'));
  }, [projects]);

  return { projects: sortedProjects, isLoading, refetch };
};
