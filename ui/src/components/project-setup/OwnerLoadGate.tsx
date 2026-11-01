import { ReactNode } from 'react';
import { ProjectLoadGate } from './ProjectLoadGate';

/**
 * The provider Load for a dock that names one (`?provider=`): its home, its files. An APP view is never
 * gated here — it is brought up by its own lifecycle record (`AppDisplayViewer` → `useAppLifecycle`).
 */
export function OwnerLoadGate({
  urlProject,
  display,
  children,
}: {
  urlProject: string;
  display: string;
  children: ReactNode;
}) {
  return (
    <ProjectLoadGate key={urlProject} projectId={urlProject} display={display}>
      {children}
    </ProjectLoadGate>
  );
}
