import { Trans, useLingui } from '@lingui/react/macro';
import type { Agent, Deployment, Project } from '@sdk';
import { useEntity } from '@sdk/react/hooks';

/** "commit 1a2b3c4d", "tag v1.2 · 1a2b3c4d" — what a deployment follows, and the commit actually on the box. */
export function useSourceLabel(): (deployment: Deployment) => string {
  const { t } = useLingui();
  return (deployment) => {
    const kind =
      deployment.source_kind === 'tag' ? t`tag` : deployment.source_kind === 'release' ? t`release` : t`commit`;
    const ref = deployment.source_kind === 'commit' ? deployment.source_ref?.slice(0, 8) : deployment.source_ref;
    const running = deployment.source_revision?.slice(0, 8);
    return [ref ? `${kind} ${ref}` : kind, running && running !== ref ? running : null].filter(Boolean).join(' · ');
  };
}

/** The source line on a deployment's page: what it follows, and what runs. */
export function DeploymentSource({ deployment }: { deployment: Deployment }) {
  const label = useSourceLabel()(deployment);
  return (
    <p className="py-2 text-xs text-muted-foreground" data-testid="deployment-source">
      <Trans>Source</Trans>: <span className="font-mono">{label}</span>
    </p>
  );
}

/** What the deployment maps on its machine — each declared service (a web app's routes, the agent's chat). */
export function DeploymentResources({ deployment }: { deployment: Deployment }) {
  if (!deployment.exposes.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5 pb-2" data-testid="deployment-resources">
      {deployment.exposes.map((declared) => (
        <li
          key={declared.name}
          className="rounded-full border px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
          data-testid={`deployment-resource-${declared.name}`}
        >
          {declared.name} · {declared.subkind} · {declared.protocol.spec_kind}
        </li>
      ))}
    </ul>
  );
}

/** One line of a deployment's whole context, for a row anywhere: project · main agent · source · apps. */
export function DeploymentContextLine({ deployment }: { deployment: Deployment }) {
  const { t } = useLingui();
  const { data: project } = useEntity<Project>(deployment.projectTypeId);
  const { data: agent } = useEntity<Agent>(deployment.mainAgentTypeId);
  const source = useSourceLabel()(deployment);
  const apps = deployment.exposes.map((e) => e.name).join(', ');
  return (
    <span className="truncate text-xs text-muted-foreground" data-testid={`deployment-context-${deployment.id}`}>
      {[project?.name, agent?.name ?? t`No agent`, source, apps || null].filter(Boolean).join(' · ')}
    </span>
  );
}
