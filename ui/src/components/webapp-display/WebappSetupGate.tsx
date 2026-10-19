import { Trans } from '@lingui/react/macro';
import { ProjectLoadGate } from '@src/components/project-setup/ProjectLoadGate';
import { webappAsset } from '@src/components/project-setup/use-project-load';

/** A stopped app uses the same lifecycle as dependency Open. Missing installation always asks first. */
export function WebappSetupGate({ projectId, webappId }: { projectId: string; webappId: string }) {
  return <ProjectLoadGate projectId={projectId} asset={webappAsset(webappId)}><p role="status" className="p-8 text-sm text-muted-foreground"><Trans>Opening app…</Trans></p></ProjectLoadGate>;
}
