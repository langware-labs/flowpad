import { APIEntity, Project, TypeId } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';

/** Resolve ownership from the backend entity's project field, not conversation scope. */
interface ProjectOwnedEntity extends APIEntity<ProjectOwnedEntity> {
  project_id?: string | null;
}

export function useShareOwnerProject(ownerRef: TypeId | undefined, enabled: boolean) {
  const owner = useEntity<ProjectOwnedEntity>(ownerRef ?? null, { enabled });
  const projectId = ownerRef?.type === Project.type ? ownerRef.id : owner.data?.project_id;
  const project = useEntity<Project>(projectId ? new TypeId(Project.type, projectId) : null, { enabled });
  return { project: project.data ?? null, loading: enabled && (owner.isLoading || project.isLoading) };
}
