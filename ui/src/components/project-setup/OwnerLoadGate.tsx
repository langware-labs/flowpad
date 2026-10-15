import { ReactNode } from 'react';
import { TypeId, WebApp } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { ProjectLoadGate } from './ProjectLoadGate';
import { webappAsset } from './use-project-load';
import { useAppWebappId } from '@src/hooks/flow-hooks/useAppDisplay';

/**
 * The provider Load for a dock that names one. An app's own row says which project owns it; the id a
 * link carries is only where it lived when the link was made — a dependency removed and added again
 * is a new project with the same app, and the old link must still open it.
 *
 * An app addressed by its artifact is judged on the webapp asset serving it, so it waits only for
 * what IT needs — never for the rest of the project.
 */
export function OwnerLoadGate({
  urlProject,
  appId: microAppId,
  artifactId = null,
  display,
  children,
}: {
  urlProject: string;
  appId: string | null;
  artifactId?: string | null;
  display: string;
  children: ReactNode;
}) {
  const resolved = useAppWebappId(artifactId, microAppId);
  const appId = resolved.webappId;
  const { data: app, isLoading } = useEntity<WebApp>(appId ? new TypeId(WebApp.type, appId) : null);
  if (resolved.loading || (appId && isLoading)) return null;
  const projectId = app?.project_id || urlProject;
  return (
    <ProjectLoadGate
      key={projectId}
      projectId={projectId}
      asset={webappAsset(appId)}
      display={display}
    >
      {children}
    </ProjectLoadGate>
  );
}
