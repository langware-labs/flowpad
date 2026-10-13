import { ReactNode } from 'react';
import { TypeId, WebApp } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { ProjectLoadGate } from './ProjectLoadGate';

/**
 * The provider Load for a dock that names one. An app's own row says which project owns it; the id a
 * link carries is only where it lived when the link was made — a dependency removed and added again
 * is a new project with the same app, and the old link must still open it.
 */
export function OwnerLoadGate({
  urlProject,
  appId,
  display,
  children,
}: {
  urlProject: string;
  appId: string | null;
  display: string;
  children: ReactNode;
}) {
  const { data: app, isLoading } = useEntity<WebApp>(appId ? new TypeId(WebApp.type, appId) : null);
  if (appId && isLoading) return null;
  const projectId = app?.project_id || urlProject;
  return (
    <ProjectLoadGate key={projectId} projectId={projectId} display={display}>
      {children}
    </ProjectLoadGate>
  );
}
