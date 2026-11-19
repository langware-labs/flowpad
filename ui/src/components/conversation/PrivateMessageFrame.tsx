import { useEffect, useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { EyeOff } from 'lucide-react';
import { CARD_FILE, type FlowMessage } from '@sdk';
import { sendToChannel } from '@sdk/entities/notifications';
import { Button } from '@src/components/ui/button';
import { updateMessage } from '@src/components/stream-inbox-view/stream-inbox-api';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { draftFiles } from './flow-message-drafts';

/**
 * A private message in the feed: whatever the message draws (`children`), marked as seen by this
 * person only, with Share (send it to everyone, as the last message) and Dismiss. Seeing it reads it.
 * `channel`: the conversation answers on a channel (email, Slack), so sharing sends its text and files there.
 */
export function PrivateMessageFrame({
  fm,
  channel,
  onDone,
  children,
}: {
  fm: FlowMessage;
  channel?: boolean;
  onDone?: () => void;
  children: ReactNode;
}) {
  const { t } = useLingui();
  const ensureCloudLogin = useCloudLoginGate();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (fm.id && !fm.is_read) void updateMessage(fm.id, { is_read: true }).catch(() => undefined);
  }, [fm.id, fm.is_read]);

  const run = async (work: () => Promise<void>, failed: string) => {
    setBusy(true);
    try {
      await work();
      onDone?.();
    } catch (err: unknown) {
      notify.error({ title: failed, message: errorMessage(err, ''), forceToast: true });
    } finally {
      setBusy(false);
    }
  };
  const share = () =>
    run(async () => {
      if (channel) {
        // The file a message is drawn by is for the app, not something to mail.
        const files = (await draftFiles(fm)).filter((f) => f.name !== CARD_FILE);
        await sendToChannel(fm.conversation_id ?? '', fm.text ?? '', undefined, { files: files.length ? files : undefined });
        await fm.delete();
        return;
      }
      const gate = await ensureCloudLogin();
      if (!gate.ok) throw new Error(gate.error);
      await fm.sendDraft();
    }, t`Could not share the message`);

  return (
    <div className="my-1 rounded-md border border-dashed border-border bg-muted/30 p-2" data-testid="private-message">
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <EyeOff className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {t`Only you can see this`}
          {fm.sender_name ? ` · ${fm.sender_name}` : ''}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          disabled={busy}
          onClick={() => void run(() => fm.delete(), t`Could not dismiss the message`)}
          data-testid="private-message-dismiss"
        >
          {t`Dismiss`}
        </Button>
        <Button size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={() => void share()} data-testid="private-message-share">
          {t`Share with everyone`}
        </Button>
      </div>
      {children}
    </div>
  );
}
