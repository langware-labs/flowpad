import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpCircle, GitBranch, Loader2 } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ActionInfo, dataManager, isGitOrigin, type AnyEntity, type FSOriginField, type ReceivePlan } from '@sdk';
import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import { notifyShareConflict } from '@src/lib/git-outcome';
import { ApplyPrompt } from '@src/components/conversation/asset-review/SharedOpenPanel';
import { notify } from '@src/notifications';

/** `git_share_status` (flow_sdk/app/actions/git_share_drift_action.py). */
interface GitShareStatus {
  shared: boolean;
  commit?: string;
  branch?: string | null;
  behind?: number;
  edited?: boolean;
}

/** A received git share names the commit it was shared at on its origin; nothing else has one. */
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

/** `git_share_update`'s answer: the plan to confirm, or what the update came to. */
interface GitShareUpdate {
  updated?: boolean;
  code?: string | null;
  needs?: 'apply';
  plan?: ReceivePlan;
  message?: string;
  operation?: string;
  branch?: string | null;
  workdir?: string;
}

/**
 * The version a received git share is at, and the sender's newer one when the
 * shared branch moved on (only commits touching this asset, and not yet on your
 * branch, count). Update asks first: it shows the plan — a pull on the shared
 * branch, or a cherry-pick of the asset's commits — and runs it on a yes. Your
 * own edits stay yours; a clash is left for Resolve, never overwritten.
 */
export function GitShareBar({ entity }: { entity: AnyEntity }) {
  const { t } = useLingui();
  const [status, setStatus] = useState<GitShareStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<ReceivePlan | null>(null);
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

  const update = useCallback(
    async (apply: boolean) => {
      setBusy(true);
      try {
        const action = new ActionInfo('git_share_update', type, String(id), 'POST');
        action.bodyParameters = { apply };
        const res = await dataManager.callAction<unknown, GitShareUpdate>(action);
        if (res?.needs === 'apply' && res.plan) {
          setPlan(res.plan);
          return; // only a question: nothing changed, the status stands
        }
        setPlan(null);
        setNonce((n) => n + 1);
        if (res?.updated) notify.success({ title: t`Updated to the latest version` });
        else if (res?.code === 'conflict' && res.workdir) notifyShareConflict({ ...res, workdir: res.workdir });
        else notify.error({ title: t`Not updated`, message: res?.message ?? res?.code ?? undefined });
      } catch (e) {
        notify.error({ title: t`Git share failed`, message: errorMessage(e, t`Git share failed`) });
      } finally {
        setBusy(false);
      }
    },
    [type, id, t],
  );

  if (!status?.shared || !status.commit) return null;
  const spinner = <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="git-share-bar">
      <GitBranch className="h-3.5 w-3.5" />
      <span className="font-mono" title={t`The version that was shared with you`}>
        {status.commit.slice(0, 12)}
      </span>
      {!!status.behind && !plan && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void update(false)}
          data-testid="git-share-update"
        >
          {busy ? spinner : <ArrowUpCircle className="h-3.5 w-3.5" />}
          <Trans>Update ({status.behind} newer)</Trans>
        </Button>
      )}
      {plan && (
        <ApplyPrompt plan={plan} busy={busy} onConfirm={() => void update(true)} onCancel={() => setPlan(null)} />
      )}
    </div>
  );
}
