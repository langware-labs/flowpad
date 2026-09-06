/**
 * What People & teams shows someone who is IN an organization without administering it.
 *
 * The screen's main read (`budgets`) is admin-and-above on the hub, so everybody else used to land
 * on a single grey line — "Only an admin of this organization can see its budgets." — which is a
 * sentence about a permission, told to someone who has just clicked an emailed invitation and
 * wants to know what they joined. The money is genuinely not theirs to see; the membership is.
 *
 * So this renders the same card the admin gets, carrying only the fields that are the member's
 * own: the organization's name, their role in it, and the teams inside it THEY belong to with
 * their role in each. No pool, no total, no spend, and no roster of other people — the hub's
 * `standing` read (`standingService.orgStanding`) carries none of that, which is what lets it sit
 * on `reader` where `budgets` sits on `admin`. Nothing here is derived from a role string held in
 * the browser: the role shown is the one the hub resolved.
 */
import { Loader2 } from 'lucide-react';
import { Trans } from '@lingui/react/macro';

import { useOrgStanding } from './use-budgets';

/** The caller's role, as the hub resolved it — a plain pill, never an editable control. */
function RoleChip({ role, testId }: { role: string; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className="whitespace-nowrap rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground"
    >
      <Trans>you are {role}</Trans>
    </span>
  );
}

export function MemberStanding({ orgId, orgName }: { orgId: string; orgName?: string }) {
  const { data, isLoading, error } = useOrgStanding(orgId);

  // The name is the one thing this card cannot do without, and the org list already carries it —
  // so a standing read that is still in flight (or that a hub too old to answer it refused)
  // degrades to the name alone rather than to a spinner that may never end.
  const name = data?.name || orgName || '';
  const teams = data?.teams ?? [];
  // A read that FAILED knows nothing about this person's teams, and "you are not in any team" is
  // not the same statement as "we could not ask" — so the section goes away rather than asserting
  // an emptiness nobody established.
  const teamsKnown = !error;

  return (
    <section className="rounded-lg border border-border" data-testid="org-standing">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="min-w-0 truncate text-lg font-semibold" data-testid="org-standing-name">
          {name}
        </h2>
        <div className="flex items-center gap-2">
          {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          {data?.role && <RoleChip role={data.role} testId="org-standing-role" />}
        </div>
      </div>

      {teamsKnown && (
        <div className="flex flex-col gap-2 py-3 pl-10 pr-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Trans>Your teams</Trans>
          </div>
          {teams.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {isLoading ? <Trans>Loading…</Trans> : <Trans>You are not in any team in this organization yet.</Trans>}
            </p>
          ) : (
            <ul
              className="flex flex-col divide-y divide-border rounded-md border border-border"
              data-testid="org-standing-teams"
            >
              {teams.map((team) => (
                <li key={team.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 truncate text-sm font-medium">{team.name}</span>
                  <RoleChip role={team.role} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
