import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpCircle, GitBranch, Loader2, Send } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ActionInfo, dataManager, isGitOrigin, type AnyEntity, type FSOriginField } from '@sdk';
import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { useLocalUser } from '@src/components/conversation/useLocalUser';

/** `git_share_status` (flow_sdk/app/actions/git_share_drift_action.py). */
interface GitShareStatus {
  shared: boolean;
  commit?: string;
  branch?: string | null;
  behind?: number;
  edited?: boolean;
}

/** A received git share pins a commit on its origin; nothing else has one. */
export function isGitShare(entity: AnyEntity | null): boolean {
  const origin = (entity as { origin?: FSOriginField | null } | null)?.origin;
  return isGitOrigin(origin) && !!origin.head_commit;
}

/**
 * An editor with its git-share bar above it when the entity is a received
 * share. The structure is the same either way, so the editor is never
 * remounted when the entity resolves into a share.
 */
export function GitShareFrame({ entity, children }: { entity: AnyEntity | null; children: ReactNode }) {
  const shared = isGitShare(entity);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {shared && entity && (
        <div className="flex h-9 flex-shrink-0 items-center border-b px-3">
          <GitShareBar entity={entity} />
        </div>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * The version a received git share is at, and what can happen next: take the
 * sender's newer version (only commits touching this asset count), or send
 * your own edits back on a `share/<you>/<asset>` branch. Never overwrites an
 * edited copy — the backend refuses that, and the Update button is not offered.
 */
export function GitShareBar({ entity }: { entity: AnyEntity }) {
  const { t } = useLingui();
  const { localUser } = useLocalUser();
  const [status, setStatus] = useState<GitShareStatus | null>(null);
  const [busy, setBusy] = useState<'update' | 'send' | null>(null);
  const [nonce, setNonce] = useState(0);
  const { type, id } = entity.typeId;

  useEffect(() => {
    let live = true;
    const action = new ActionInfo('git_share_status', type, String(id), 'GET');
    void dataManager
      .callAction<null, GitShareStatus>(action)
      .then((res) => live && setStatus(res ?? null))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [type, id, nonce]);

  const run = useCallback(
    async (which: 'update' | 'send') => {
      // One table instead of four branches: the action, its body, and what it says.
      const op = {
        update: {
          action: 'git_share_update',
          body: undefined,
          done: 'updated',
          ok: t`Updated to the latest version`,
          fail: t`Not updated`,
        },
        send: {
          action: 'git_share_send_back',
          body: { sender: localUser?.name ?? 'receiver' },
          done: 'sent',
          ok: t`Your edits were sent back`,
          fail: t`Not sent`,
        },
      }[which];
      setBusy(which);
      try {
        const action = new ActionInfo(op.action, type, String(id), 'POST');
        if (op.body) action.bodyParameters = op.body;
        const res = await dataManager.callAction<unknown, Record<string, unknown>>(action);
        if (res?.[op.done]) notify.success({ title: op.ok, message: (res.branch as string | undefined) ?? undefined });
        else notify.error({ title: op.fail, message: (res?.code as string | undefined) ?? undefined });
      } catch (e) {
        notify.error({ title: t`Git share failed`, message: errorMessage(e, t`Git share failed`) });
      } finally {
        setBusy(null);
        setNonce((n) => n + 1);
      }
    },
    [type, id, t, localUser?.name],
  );

  if (!status?.shared || !status.commit) return null;
  const spinner = <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="git-share-bar">
      <GitBranch className="h-3.5 w-3.5" />
      <span className="font-mono" title={t`The version that was shared with you`}>
        {status.commit.slice(0, 12)}
      </span>
      {!!status.behind && !status.edited && (
        <Button
          size="sm"
          variant="outline"
          disabled={!!busy}
          onClick={() => void run('update')}
          data-testid="git-share-update"
        >
          {busy === 'update' ? spinner : <ArrowUpCircle className="h-3.5 w-3.5" />}
          <Trans>Update ({status.behind} newer)</Trans>
        </Button>
      )}
      {status.edited && (
        <Button
          size="sm"
          variant="outline"
          disabled={!!busy}
          onClick={() => void run('send')}
          data-testid="git-share-send-back"
        >
          {busy === 'send' ? spinner : <Send className="h-3.5 w-3.5" />}
          <Trans>Send my edits back</Trans>
        </Button>
      )}
    </div>
  );
}
