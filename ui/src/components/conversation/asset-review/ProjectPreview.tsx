import type { Project } from '@sdk';
import { gitOriginCloneUrl } from '@sdk/models/GitOrigin';
import { Trans, useLingui } from '@lingui/react/macro';

/**
 * Read-only preview of a shared project in the review popup — the project's
 * counterpart of `StagedTranscriptPreview`. A transcript previews from the bytes
 * that rode in the message; a project invite is a body-free reference with no
 * staged files, so this previews from the Project row itself: its name and the
 * git URL that Clone & Open clones. Meant to grow.
 */
export function ProjectPreview({ project, fallbackName }: { project?: Project | null; fallbackName?: string | null }) {
  const { t } = useLingui();
  const name = project?.name || fallbackName || t`Project`;
  const gitUrl = project?.origin ? gitOriginCloneUrl(project.origin) : null;
  return (
    <dl
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded border border-border p-3 text-[12px]"
      data-testid="project-preview"
    >
      <dt className="text-muted-foreground">
        <Trans>Name</Trans>
      </dt>
      <dd className="truncate" data-testid="project-preview-name">
        {name}
      </dd>
      <dt className="text-muted-foreground">
        <Trans>Git URL</Trans>
      </dt>
      <dd className="truncate font-mono text-[11px]" title={gitUrl ?? undefined} data-testid="project-preview-git-url">
        {gitUrl ?? '—'}
      </dd>
    </dl>
  );
}
