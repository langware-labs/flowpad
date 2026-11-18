import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Loader2, PenLine } from 'lucide-react';
import { discardTicketDraft, sendTicketDraft } from '@sdk/entities/conversation';
import { TicketDraftStatus, type TicketDraftMeta } from '@sdk/entities/flow-message';
import { Button } from '@src/components/ui/button';
import { Textarea } from '@src/components/ui/textarea';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

/**
 * Under an agent's draft in a ticket's team conversation: while pending, Send / Edit / Discard -- Send gives the
 * answer to the requester (as edited) and the ticket to whoever pressed it. Once decided, who sent or dropped it.
 * The hub keeps the decision on the message, so every team member's copy changes with it.
 */
export function TicketDraftLine({
  draft,
  messageId,
  text,
}: {
  draft: TicketDraftMeta;
  messageId: string;
  text: string;
}) {
  const { t } = useLingui();
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(text);
  const [busy, setBusy] = useState<'send' | 'discard' | null>(null);

  if (draft.status !== TicketDraftStatus.PENDING) {
    const by = draft.by ?? '';
    return (
      <p className="mt-1 text-xs text-muted-foreground" data-testid="ticket-draft-settled">
        {draft.status === TicketDraftStatus.SENT
          ? draft.edited
            ? t`Edited and sent to the customer by ${by}`
            : t`Sent to the customer by ${by}`
          : t`Discarded by ${by}`}
      </p>
    );
  }

  const run = async (verb: 'send' | 'discard') => {
    setBusy(verb);
    try {
      if (verb === 'send') await sendTicketDraft(draft.ticket_id, messageId, editing ? edited : undefined);
      else await discardTicketDraft(draft.ticket_id, messageId);
      setEditing(false);
    } catch (e: unknown) {
      notify.error({
        title: verb === 'send' ? t`Could not send the draft` : t`Could not discard the draft`,
        message: errorMessage(e, ''),
        forceToast: true,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-1 flex flex-col gap-2" data-testid="ticket-draft">
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <PenLine className="h-3 w-3" aria-hidden />
        {t`Draft for the customer — not sent`}
      </span>
      {editing && (
        <Textarea
          aria-label={t`Answer to the customer`}
          value={edited}
          onChange={(e) => setEdited(e.target.value)}
          rows={4}
          data-testid="ticket-draft-editor"
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy !== null || (editing && !edited.trim())}
          onClick={() => void run('send')}
          data-testid="ticket-draft-send"
        >
          {busy === 'send' && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
          {t`Send to the customer`}
        </Button>
        {!editing && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => {
              setEdited(text);
              setEditing(true);
            }}
          >
            {t`Edit`}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => void run('discard')}
          data-testid="ticket-draft-discard"
        >
          {busy === 'discard' && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
          {t`Discard`}
        </Button>
      </div>
    </div>
  );
}
