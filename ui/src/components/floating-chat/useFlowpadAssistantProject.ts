import { FLOWPAD_ASSISTANT_PROJECT_UNAME, Project, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useMemo } from 'react';

interface UseFlowpadAssistantProjectResult {
  project: Project | null;
  /** TypeId string suitable as `target` for EntityExecutionPanel. Null until the project is resolved. */
  target: string | null;
  isLoading: boolean;
}

/**
 * Resolves the system Flowpad Assistant project by its uname (@flowpad_assistant).
 *
 * Project lookup goes through `useEntity` with a TypeId of `project-@flowpad_assistant`
 * because the standard project list (`useProjects()`) excludes system projects on the
 * backend and would never surface the assistant entry. The @uname form is the canonical
 * stable reference — same one the footer's "Flowpad docs" button uses.
 */
export function useFlowpadAssistantProject(): UseFlowpadAssistantProjectResult {
  const typeId = useMemo(
    () => new TypeId(Project.type, `@${FLOWPAD_ASSISTANT_PROJECT_UNAME}`),
    [],
  );
  const { data: project, isLoading } = useEntity<Project>(typeId);

  const target = useMemo(
    () => (project?.id ? new TypeId(Project.type, project.id).toString() : null),
    [project?.id],
  );

  return { project: project ?? null, target, isLoading };
}
