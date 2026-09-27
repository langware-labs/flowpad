/**
 * What a project share did to each person — invited, skipped (and why), failed
 * (and why) — plus any team the sharer's client could not expand.
 *
 * Shared by the project share dialog and the team page's "Share project", which
 * both invite through `Project.invite` and get one `ShareResult` back.
 */
import type { ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { ShareRecipient, ShareResult, SkippedTeam } from '@sdk';

/** A better name for a result row than the row carries — e.g. the contact the sharer picked. */
export type RecipientNamer = (recipient: ShareRecipient) => string | null | undefined;

function Section({ testId, title, children }: { testId: string; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <p className="text-[11px] uppercase tracking-widest text-muted-foreground">{title}</p>
      <ul className="flex flex-col gap-0.5 text-sm">{children}</ul>
    </div>
  );
}

function Row({ name, detail }: { name: string; detail?: string | null }) {
  return (
    <li className="flex min-w-0 items-baseline gap-2" data-testid="share-invite-row">
      <span className="truncate text-foreground">{name}</span>
      {detail && <span className="min-w-0 truncate text-xs text-muted-foreground">{detail}</span>}
    </li>
  );
}

export function ShareInviteSummary({ result, nameOf }: { result: ShareResult; nameOf?: RecipientNamer }) {
  const { t } = useLingui();

  const label = (r: ShareRecipient) => r.name || nameOf?.(r) || r.email || r.user_id || t`Unknown person`;

  const skipReason = (reason: string) => {
    switch (reason) {
      case 'self':
        return t`That's you`;
      case 'already_member':
        return t`Already has access`;
      case 'already_invited':
        return t`Already invited`;
      default:
        return reason;
    }
  };

  const teamReason = (team: SkippedTeam) =>
    team.reason === 'not_listable' ? t`You can't list this team's members` : t`No members to invite`;

  return (
    <div className="flex w-full min-w-0 flex-col gap-3" data-testid="share-invite-summary">
      {result.invited.length > 0 && (
        <Section testId="share-invite-invited" title={t`Invited`}>
          {result.invited.map((r, i) => (
            <Row key={`${r.user_id ?? r.email}-${i}`} name={label(r)} />
          ))}
        </Section>
      )}
      {result.skipped.length > 0 && (
        <Section testId="share-invite-skipped" title={t`Not invited`}>
          {result.skipped.map((r, i) => (
            <Row key={`${r.user_id ?? r.email}-${i}`} name={label(r)} detail={skipReason(r.reason)} />
          ))}
        </Section>
      )}
      {result.failed.length > 0 && (
        <Section testId="share-invite-failed" title={t`Could not invite`}>
          {result.failed.map((r, i) => (
            <Row key={`${r.user_id ?? r.email}-${i}`} name={label(r)} detail={r.message} />
          ))}
        </Section>
      )}
      {result.skipped_teams.length > 0 && (
        <Section testId="share-invite-skipped-teams" title={t`Teams not expanded`}>
          {result.skipped_teams.map((team) => (
            <Row key={team.team} name={team.name || team.team} detail={teamReason(team)} />
          ))}
        </Section>
      )}
    </div>
  );
}
