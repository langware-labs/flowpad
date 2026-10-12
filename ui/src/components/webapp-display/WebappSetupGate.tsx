import { Trans } from '@lingui/react/macro';
import { ProjectLoadGate } from '@src/components/project-setup/ProjectLoadGate';

/** A stopped app uses the same lifecycle as dependency Open. Missing installation always asks first. */
export function WebappSetupGate({ projectId }: { projectId: string; webappId: string }) {
  return <ProjectLoadGate projectId={projectId}><p role="status" className="p-8 text-sm text-muted-foreground"><Trans>Opening app…</Trans></p></ProjectLoadGate>;
}
