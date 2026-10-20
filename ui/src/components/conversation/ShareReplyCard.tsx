import type { FlowMessage } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertTriangle, Check, Forward, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@src/components/ui/button';
import { useSendToConversation } from '@src/hooks/use-send-to-conversation';

/** Marker keys the receiver's reply carries in its URL attachment's `prompt_preview`
 *  (backend: `message_attachment_action.GIT_ACCESS_REQUEST_KEY` / `SHARE_MISMATCH_KEY`). */
const GIT_ACCESS_REQUEST = 'git_access_request';
const SHARE_MISMATCH = 'share_mismatch_report';

interface ShareReplyDetail {
  requester_name?: string | null;
  requester_email?: string | null;
  repo_url?: string;
  branch?: string | null;
  path?: string | null;
  asset_name?: string | null;
  project_name?: string | null;
}

/** The structured share reply riding this message, if any. */
export function shareReplyOf(fm: FlowMessage | undefined): { kind: string; detail: ShareReplyDetail } | null {
  for (const a of fm?.attachment ?? []) {
    if (a.attachment_type !== 'url' || !a.prompt_preview) continue;
    try {
      const marker = JSON.parse(a.prompt_preview) as Record<string, ShareReplyDetail>;
      for (const kind of [GIT_ACCESS_REQUEST, SHARE_MISMATCH]) if (marker[kind]) return { kind, detail: marker[kind] };
    } catch {
      /* not a marker */
    }
  }
  return null;
}

/**
 * A receiver's reply about a share, as a card for the sharer:
 *  - "Git request access": give the access by hand (outside Flowpad, for now), then
 *    **Done** tells the requester to open it again — or **Forward** it to someone who can;
 *  - "Please check": the receiver's project for this conversation is not a checkout of the repo.
 */
export function ShareReplyCard({
  fm,
  isMine,
  onForward,
}: {
  fm: FlowMessage;
  isMine: boolean;
  onForward?: () => void;
}) {
  const { t } = useLingui();
  const reply = shareReplyOf(fm);
  const { send, busy } = useSendToConversation();
  const [done, setDone] = useState(false);
  if (!reply) return null;
  const { kind, detail } = reply;
  const who = detail.requester_name || detail.requester_email || t`The receiver`;
  const where = [detail.repo_url, detail.branch, detail.path].filter(Boolean).join(' · ');

  const markDone = async () => {
    if (!fm.conversation_id) return;
    const repo = detail.repo_url ?? '';
    const file = detail.asset_name ?? '';
    const ok = await send(
      { kind: 'existing', conversationId: fm.conversation_id },
      { text: t`Git access to ${repo} is set. Open ${file} again.` },
    );
    if (ok) setDone(true);
  };

  return (
    <div
      className="ms-10 mt-1 flex max-w-xl flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs"
      data-testid={kind === GIT_ACCESS_REQUEST ? 'git-access-request-card' : 'share-mismatch-card'}
    >
      <div className="flex items-center gap-1.5 font-medium">
        {kind === GIT_ACCESS_REQUEST ? <KeyRound className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
        {kind === GIT_ACCESS_REQUEST ? <Trans>Git request access</Trans> : <Trans>Please check the shared repo</Trans>}
      </div>
      <p className="text-muted-foreground">
        {kind === GIT_ACCESS_REQUEST ? (
          <Trans>
            {who} asks for access to <span className="font-mono">{where}</span>
          </Trans>
        ) : (
          <Trans>
            {who} has this conversation in project {detail.project_name ?? '—'}, which is not a checkout of{' '}
            <span className="font-mono">{where}</span>
          </Trans>
        )}
      </p>
      {kind === GIT_ACCESS_REQUEST && !isMine && (
        <div className="flex items-center gap-2">
          {done ? (
            <span className="flex items-center gap-1 text-green-600">
              <Check className="h-3.5 w-3.5" />
              <Trans>Done</Trans>
            </span>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void markDone()}
              data-testid="git-access-done"
            >
              <Check className="h-3.5 w-3.5" />
              <Trans>Done — access given</Trans>
            </Button>
          )}
          {onForward && (
            <Button size="sm" variant="outline" onClick={onForward} data-testid="git-access-forward">
              <Forward className="h-3.5 w-3.5" />
              <Trans>Forward</Trans>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
