import { Trans, useLingui } from '@lingui/react/macro';
import type { Project } from '@sdk';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { Link } from 'react-router';

/** How many projects the banner names; the rest are one click away in the project picker. */
const MAX_LISTED = 3;

/**
 * The projects other people gave `myId` access to, most recently updated first.
 *
 * "Shared" is read off the hub row's creator: a project someone else created is
 * one this user was brought into. The creator is attribution, not an ownership
 * record, so this only decides who gets a nudge — never who may open what. A row
 * with no creator is kept: better a nudge too many than none. App-managed
 * projects never are shared work.
 */
export function sharedProjectsToOpen(projects: readonly Project[] | undefined, myId: string | undefined): Project[] {
  return (projects ?? [])
    .filter((p) => !p.hidden && (!p.created_by || p.created_by !== myId))
    .sort((a, b) => String(b.updated_date ?? '').localeCompare(String(a.updated_date ?? '')));
}

/**
 * The hub home's "you have a project — open it in FlowPad" banner.
 *
 * Someone invited into a project who lands on the hub home (signed in from the
 * generic login page, or from a link that did not survive) would otherwise find
 * nothing pointing at FlowPad. Each project links to its landing page, the one
 * with "Open in FlowPad" and the download link, so the way to the app is one click.
 *
 * Hub-only: the landing route does not exist on a desktop backend.
 */
export function SharedProjectsBanner({ projects }: { projects: readonly Project[] }) {
  const { t } = useLingui();
  if (!isHubOnly() || projects.length === 0) return null;

  const listed = projects.slice(0, MAX_LISTED);
  const more = projects.length - listed.length;
  return (
    <section
      data-testid="hub-home-shared-projects"
      className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/5 p-5"
    >
      <h2 className="text-base font-semibold">
        <Trans>Open your shared projects in FlowPad</Trans>
      </h2>
      <p className="text-sm text-muted-foreground">
        <Trans>
          FlowPad is a free, open-source desktop app for working on projects with your coding agents. Open a project
          there and FlowPad sets it up on your machine.
        </Trans>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {listed.map((project) => (
          <Link
            key={project.id}
            to={`/project/${project.id}`}
            data-testid={`hub-home-shared-project-${project.id}`}
            className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {project.name || t`Untitled project`}
          </Link>
        ))}
        {more > 0 && (
          <span className="text-xs text-muted-foreground">
            <Trans>+{more} more — find them under Select Project</Trans>
          </span>
        )}
      </div>
    </section>
  );
}
