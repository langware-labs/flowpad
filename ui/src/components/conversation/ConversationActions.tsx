import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Conversation } from '@sdk/entities/conversation';
import type { FlowMessage } from '@sdk/entities/flow-message';
import { authoredBy, senderOf } from '@sdk/models/MessageSender';
import type { IActionSpec } from '@sdk/models/ChannelSpec';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { Button } from '@src/components/ui/button';
import { InputDialog } from '@src/components/ui/input-dialog';
import { lucideByName } from '@src/lib/lucide-by-name';
import { errorMessage } from '@src/lib/error-message';
import { formatTimeAgo } from '@src/utils/format-time-ago';

type Pending = { action: IActionSpec; mode: 'confirm' | 'text' };

/** Whether an action is offered in this state of the conversation (`when` defaults to open). */
const offered = (action: IActionSpec, ended: boolean) =>
  (action.when ?? 'open') === 'any' || (action.when ?? 'open') === (ended ? 'ended' : 'open');

const sentAt = (m: FlowMessage) => new Date(m.sent_at ?? m.created_date ?? 0).getTime();

/** The newest MARKED message this account wrote — what an action's `done_mark` reads. A plain comment
 * or an assignment after an approval does not take the approval back, so unmarked messages are skipped. */
function newestOurs(messages: ReadonlyArray<FlowMessage>, selfIds: ReadonlyArray<string | null | undefined>) {
  let newest: FlowMessage | null = null;
  for (const m of messages) {
    if (m.mark && authoredBy(senderOf(m), selfIds) && (!newest || sentAt(m) > sentAt(newest))) newest = m;
  }
  return newest;
}

/**
 * The channel's verbs on the whole conversation (`channel_spec.actions`), rendered by trait only —
 * the channel says what it offers and does it. Each action says whether it belongs to an open or an
 * ended conversation. A refusal shows the channel's own words in place. An action whose `done_mark`
 * is the mark on the newest message we sent ("approved") is drawn done instead of as a button.
 */
export function ConversationActions({
  conversation,
  messages = [],
  selfIds = [],
  onDone,
}: {
  conversation: Conversation;
  /** The conversation's messages, as the view already holds them. */
  messages?: ReadonlyArray<FlowMessage>;
  /** The signed-in account's ids (cloud + local user). */
  selfIds?: ReadonlyArray<string | null | undefined>;
  onDone?: () => void;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const ended = !!conversation.ended_at;
  const actions = (conversation.channel_spec?.actions ?? []).filter((a) => offered(a, ended));
  if (actions.length === 0) return null;
  const ours = newestOurs(messages, selfIds);

  const run = async (action: IActionSpec, words = '') => {
    setBusy(action.id);
    setFailure(null);
    try {
      await conversation.act(action.id, words);
      onDone?.();
    } catch (err) {
      setFailure(errorMessage(err, t`${action.label} failed`));
    } finally {
      setBusy(null);
    }
  };

  const start = (action: IActionSpec) => {
    if (action.needs_text) setPending({ action, mode: 'text' });
    else if (action.confirm) setPending({ action, mode: 'confirm' });
    else void run(action);
  };
  const close = (open: boolean) => !open && setPending(null);

  return (
    <div className="flex w-full flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        {actions.map((action) => {
          if (action.done_mark && ours?.mark?.key === action.done_mark) {
            const when = formatTimeAgo(ours.sent_at ?? ours.created_date ?? '') ?? '';
            const label = ours.mark.label;
            return (
              <span
                key={action.id}
                aria-disabled="true"
                data-testid={`conversation-action-done-${action.id}`}
                className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-muted/50 px-2 text-[11px] text-muted-foreground"
              >
                <Trans>
                  ✓ {label} · {when}
                </Trans>
              </span>
            );
          }
          const Icon = lucideByName(action.icon_name);
          return (
            <Button
              key={action.id}
              variant="outline"
              size="sm"
              onClick={() => start(action)}
              disabled={busy !== null}
              data-testid={`conversation-action-${action.id}`}
              className="h-6 gap-1 px-2 text-[11px]"
            >
              <Icon className="h-3 w-3" />
              {busy === action.id ? <Trans>Working…</Trans> : action.label}
            </Button>
          );
        })}
      </div>
      {failure && (
        // Tinted with a red border; the words stay the foreground colour.
        <p
          role="alert"
          data-testid="conversation-action-error"
          className="w-full rounded border border-red-500/60 bg-red-500/10 px-2 py-1 text-xs"
        >
          {failure}
        </p>
      )}
      <ConfirmDialog
        open={pending?.mode === 'confirm'}
        onOpenChange={close}
        title={pending?.action.label ?? ''}
        description={pending?.action.confirm ?? ''}
        confirmLabel={pending?.action.label ?? t`Confirm`}
        cancelLabel={t`Cancel`}
        variant={pending?.action.destructive ? 'destructive' : 'default'}
        onConfirm={() => pending && void run(pending.action)}
        testId="conversation-action-confirm"
      />
      <InputDialog
        open={pending?.mode === 'text'}
        onOpenChange={close}
        title={pending?.action.label ?? ''}
        placeholder={t`Why?`}
        confirmLabel={t`Send`}
        cancelLabel={t`Cancel`}
        onConfirm={(words) => pending && void run(pending.action, words)}
        multiline
        testId="conversation-action-text"
      />
    </div>
  );
}

/** The muted line under an ended conversation. The composer stays — a reply may reopen it. */
export function ConversationEndedLine({ endedAt }: { endedAt: string | Date | null | undefined }) {
  if (!endedAt) return null;
  const when = formatTimeAgo(endedAt) ?? '';
  return (
    <p data-testid="conversation-ended" className="text-center text-[11px] text-muted-foreground/70">
      <Trans>Ended · {when}</Trans>
    </p>
  );
}
