import type { MessageAttachment } from '@sdk';
import { Trans } from '@lingui/react/macro';
import { FolderGit2, FolderOpen, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@src/components/ui/button';
import { ReplacePrompt } from './ReplacePrompt';
import { useOpenGitShare, type OpenShareOpts, type OpenShareOutcome } from './use-open-git-share';

/**
 * A received share that carries Git AND a copy: one Open button, and only the
 * question the backend could not answer itself —
 *   - 2+ of the receiver's projects are checkouts of the repo: which one (asked once);
 *   - none: clone the repo as a project, or open the copy.
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
          </div>
        </div>
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
