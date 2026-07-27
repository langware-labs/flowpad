import { useCallback, useMemo, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { AgenticProcess, Conversation, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { workerIcon } from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';
import { FavoriteStar } from '@src/components/favorites/FavoriteStar';
import { AdvancedOnly } from '@src/components/view-mode';
import { InputDialog } from '@src/components/ui/input-dialog';
import { localBundleUrl } from '../flow-message-drafts';
import { useChipsExclude } from './ChipsExcludeContext';
import { ChipKey } from './keys';

interface MessageChipsProps {
  flowMessageId?: string;
  /** Parent conversation id — the conversation's context is where the current
   *  worker is found (the most-recently-linked AgenticProcess). */
  conversationId?: string;
  /** Message body — its first 10 words become the favorite / task title. */
  messageText?: string;
}

/** First `n` whitespace-delimited words of `text`, trimmed. Empty when no text. */
function firstWords(text: string | undefined, n: number): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  return t.split(/\s+/).slice(0, n).join(' ');
}

/**
 * Per-message chip row. Left group: download + (advanced view only) a single
 * "append to the conversation's current worker" button showing that worker's
 * harness icon. Clicking opens a one-line modal whose text is appended to the
 * process's prompt queue as ``Re message <id>:\n<line>``. Right group
 * (``ml-auto``): favorite star, titled from the message's first 10 words.
 *
 * There is intentionally no per-message *launch* button — a worker is launched
 * once per conversation from the Private Context panel (in the conversation's
 * own project); per-message actions feed that existing worker via its queue.
 *
 * Anything already rendered by a higher-level chip row (Task or Conversation)
 * is suppressed via ``ChipsExcludeContext``.
 */
export function MessageChips({ flowMessageId, conversationId, messageText }: MessageChipsProps) {
  const { t } = useLingui();
  const exclude = useChipsExclude();
  const [pending, setPending] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Skin-layer rule (docs/viewmodes.md): hooks run unconditionally; the
  // AdvancedOnly wrapper below only gates visibility, never the data flow.
  // The conversation's current worker = the most-recently-linked AgenticProcess
  // in its shared context (where startSession publishes launched workers).
  const convTypeId = useMemo(
    () => (conversationId ? new TypeId(Conversation.type, conversationId) : null),
    [conversationId],
  );
  const { data: conversation } = useEntity<Conversation>(convTypeId);
  const processTypeId = useMemo(() => {
    const procs = (conversation?.sharedContextEntities ?? []).filter((t) => t.type === AgenticProcess.type);
    return procs.length ? procs[procs.length - 1] : null;
  }, [conversation]);
  const { data: currentProcess } = useEntity<AgenticProcess>(processTypeId);

  const title = firstWords(messageText, 10) || `Message ${flowMessageId?.slice(0, 8) ?? ''}`.trim();

  const handleAppend = useCallback(
    async (line: string) => {
      const trimmed = line.trim();
      if (pending || !flowMessageId || !currentProcess) return;
      setPending(true);
      try {
        await currentProcess.enqueue(`Re message ${flowMessageId}:\n${trimmed}`, 'ui');
      } catch (err) {
        console.error('[MessageChips] enqueue failed', err);
      } finally {
        setPending(false);
      }
    },
    [pending, flowMessageId, currentProcess],
  );

  if (!flowMessageId) return null;
  const showDownload = !exclude.has(ChipKey.download(flowMessageId));
  const Icon = workerIcon(currentProcess?.worker_type ?? undefined);

  return (
    <>
      <span className="ml-1 flex items-center gap-0.5">
        {showDownload && (
          <a
            href={localBundleUrl(flowMessageId)}
            download
            title={t`Download message`}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-60 transition-opacity hover:opacity-100"
          >
            <Download className="h-3 w-3" />
          </a>
        )}
        {currentProcess && (
          <AdvancedOnly reserve={false}>
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              disabled={pending}
              title={t`Add a note to the running session about this message`}
              aria-label={t`Add a note to the running session about this message`}
              data-testid="message-append-current"
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-60 transition-opacity hover:opacity-100 disabled:cursor-not-allowed"
            >
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}
            </button>
          </AdvancedOnly>
        )}
      </span>
      <span className="ml-auto flex items-center gap-0.5">
        <FavoriteStar
          entityType="flow_message"
          entityId={flowMessageId}
          title={title}
          size={13}
          className="h-5 w-5 p-0 opacity-60 transition-opacity hover:opacity-100"
        />
      </span>
      <InputDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={t`Add to the running session`}
        description={t`Appended to the current worker's prompt queue, tagged with this message.`}
        placeholder={t`What should the worker do with this message?`}
        confirmLabel={t`Add to queue`}
        onConfirm={(value) => void handleAppend(value)}
      />
    </>
  );
}
