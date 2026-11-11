import type { MessageAttachment, ReceivePlan } from '@sdk';
import { Trans } from '@lingui/react/macro';
import { FolderGit2, FolderOpen, GitPullRequestArrow, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@src/components/ui/button';
import { ReplacePrompt } from './ReplacePrompt';
import { useOpenGitShare, type OpenShareOpts, type OpenShareOutcome } from './use-open-git-share';

/**
 * A received git share: one Open button, and only the question the backend
 * could not answer itself —
 *   - 2+ of the receiver's projects are checkouts of the repo: which one (asked once);
 *   - none: clone the repo as a project, or (when a copy rode along) open the copy;
 *   - the checkout does not hold the shared version yet: yes to the pull /
 *     cherry-pick that brings it in (`ApplyPrompt`).
 * What it came to (opened from the copy, a project mismatch) is said by the
 * open itself (`useOpenGitShare`), with the reply to send the sharer.
 */
export function SharedOpenPanel({
  attachment,
  initialOutcome,
}: {
  attachment: MessageAttachment;
  initialOutcome?: OpenShareOutcome | null;
}) {
  const { run, busy } = useOpenGitShare(attachment);
  const [outcome, setOutcome] = useState<OpenShareOutcome>(initialOutcome ?? {});
  const opened = attachment.effectiveScope != null;
  const hasCopy = attachment.transfer_mode === 'both';
  const spinner = busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null;

  const open = async (opts: OpenShareOpts = {}) => setOutcome(await run(opts));

  return (
    <div className="flex flex-col gap-2" data-testid="shared-open-panel">
      {!opened && !outcome.needs && (
        <div>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void open()} data-testid="shared-open">
            {spinner ?? <FolderOpen className="h-3.5 w-3.5" />}
            <Trans>Open</Trans>
          </Button>
        </div>
      )}
      {!opened && outcome.needs === 'choice' && (
        <div className="flex flex-col gap-1.5" data-testid="shared-choose-project">
          <p className="text-xs text-muted-foreground">
            <Trans>You have this repo in more than one project. Open it in:</Trans>
          </p>
          <div className="flex flex-wrap gap-2">
            {(outcome.candidates ?? []).map((c) => (
              <Button
                key={c.id}
                size="sm"
                variant="secondary"
                disabled={busy}
                title={c.path}
                onClick={() => void open({ projectId: c.id })}
                data-testid={`shared-choose-${c.id}`}
              >
                {c.name}
              </Button>
            ))}
          </div>
        </div>
      )}
      {!opened && outcome.needs === 'placement' && (
        <div className="flex flex-col gap-1.5" data-testid="shared-placement">
          <p className="text-xs text-muted-foreground">
            <Trans>You don't have this repo yet.</Trans>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void open({ choice: 'clone' })}
              data-testid="shared-clone"
            >
              {spinner ?? <FolderGit2 className="h-3.5 w-3.5" />}
              <Trans>Clone as project</Trans>
            </Button>
            {hasCopy && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void open({ choice: 'copy' })}
                data-testid="shared-copy"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                <Trans>Open the copy</Trans>
              </Button>
            )}
          </div>
        </div>
      )}
      {!opened && outcome.needs === 'apply' && outcome.plan && (
        <ApplyPrompt
          plan={outcome.plan}
          busy={busy}
          onConfirm={() => void open({ ...outcome.asked, apply: true })}
          onCancel={() => setOutcome({})}
        />
      )}
      {!opened && outcome.needs === 'overwrite' && (
        <ReplacePrompt
          busy={busy}
          onConfirm={() => void open({ ...outcome.asked, overwrite: true })}
          testId="shared-overwrite"
        />
      )}
      {outcome.error && (
        <p className="text-xs text-destructive" data-testid="shared-open-error">
          {outcome.error}
        </p>
      )}
    </div>
  );
}

/**
 * Yes to bringing the shared version into the receiver's own checkout: a pull on
 * the shared branch, or a cherry-pick of the commits that touch the asset. The
 * files those commits change outside the asset are listed before anything runs.
 */
export function ApplyPrompt({
  plan,
  busy,
  onConfirm,
  onCancel,
}: {
  plan: ReceivePlan;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const count = plan.commits.length;
  const branch = plan.branch;
  return (
    <div className="flex flex-col gap-1.5" data-testid="shared-apply">
      <p className="text-xs text-muted-foreground">
        {plan.action === 'pull' ? (
          <Trans>Your project is behind on {branch}. Pull to bring the shared version in.</Trans>
        ) : (
          <Trans>
            Bring the shared changes ({count}) into {branch}.
          </Trans>
        )}
      </p>
      {plan.other_files.length > 0 && (
        <div className="text-xs text-muted-foreground" data-testid="shared-apply-other-files">
          <Trans>It also changes:</Trans>
          <ul className="ms-4 list-disc font-mono">
            {plan.other_files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={busy} onClick={onConfirm} data-testid="shared-apply-confirm">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitPullRequestArrow className="h-3.5 w-3.5" />}
          {plan.action === 'pull' ? <Trans>Pull</Trans> : <Trans>Bring it in</Trans>}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel} data-testid="shared-apply-cancel">
          <Trans>Not now</Trans>
        </Button>
      </div>
    </div>
  );
}
