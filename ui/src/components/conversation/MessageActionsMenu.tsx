import { useMemo, useState } from 'react';
import { Download, Forward, MoreVertical, Pencil, Reply, SmilePlus, Star, Trash2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { AgenticProcess, Conversation, TypeId, type ICloudOrigin } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { workerIcon } from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';
import { useFavorites } from '@src/hooks/use-favorites';
import { useIsAdvanced } from '@src/components/view-mode';
import { InputDialog } from '@src/components/ui/input-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { Popover, PopoverAnchor } from '@src/components/ui/popover';
import { localBundleUrl } from './flow-message-drafts';
import { ChannelBadge } from './ChannelBadge';
import { EmojiPickerContent } from './EmojiPicker';
import { TaskItIcon, taskItHint } from './task-it';

interface MessageActionsMenuProps {
  flowMessageId?: string;
  /** Parent conversation id — its shared context names the current worker
   *  (the most-recently-linked AgenticProcess) a note is queued to. */
  conversationId?: string;
  /** Message body — its first 10 words title the favorite. */
  messageText?: string;
  /** The channel this message caches (`null` for a Flowpad-native message). */
  origin?: ICloudOrigin | null;
  forwarded?: boolean;
  onReply?: () => void;
  replyInThread?: boolean;
  onReact?: (emoji: string) => void;
  onForward?: () => void;
  /** Present only while the message is not a task yet; an opened task keeps its chips below the body. */
  onTaskIt?: () => void;
  onEditName?: () => void;
  onDelete?: () => void;
}

/** First `n` whitespace-delimited words of `text`, trimmed. Empty when no text. */
function firstWords(text: string | undefined, n: number): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  return t.split(/\s+/).slice(0, n).join(' ');
}

/** The conversation's current worker: the most-recently-linked AgenticProcess in its shared context. */
function useCurrentWorker(conversationId: string | undefined): AgenticProcess | null {
  const convTypeId = useMemo(
    () => (conversationId ? new TypeId(Conversation.type, conversationId) : null),
    [conversationId],
  );
  const { data: conversation } = useEntity<Conversation>(convTypeId);
  const processTypeId = useMemo(() => {
    const procs = (conversation?.sharedContextEntities ?? []).filter((tid) => tid.type === AgenticProcess.type);
    return procs.length ? procs[procs.length - 1] : null;
  }, [conversation]);
  return useEntity<AgenticProcess>(processTypeId).data ?? null;
}

const ITEM_ICON = 'h-3.5 w-3.5 text-muted-foreground';

/**
 * Every per-message action behind one ⋮ on the header row, so the row itself
 * reads name · time · receipt · ⋮. The items (and the favorites / worker
 * lookups they need) mount only while the menu is open — a thread renders one
 * of these per message. The note dialog and the emoji picker live OUTSIDE the
 * menu: selecting an item closes the menu, and they must outlive it.
 *
 * There is intentionally no per-message *launch* item — a worker is launched
 * once per conversation; per-message actions feed that worker via its queue.
 */
export function MessageActionsMenu(props: MessageActionsMenuProps) {
  const { t } = useLingui();
  const [noteOpen, setNoteOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { flowMessageId, conversationId, onReply, onReact, onForward, onTaskIt, onEditName, onDelete } = props;
  // A draft bubble (no stored message) with no handlers has nothing to offer.
  if (!flowMessageId && !(onReply || onReact || onForward || onTaskIt || onEditName || onDelete)) return null;

  return (
    <>
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <DropdownMenu modal={false}>
          <PopoverAnchor asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title={t`Message actions`}
                aria-label={t`Message actions`}
                data-testid="message-actions-menu"
                className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-60 transition-opacity hover:bg-muted hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
          </PopoverAnchor>
          <DropdownMenuContent align="end" className="min-w-[13rem] text-xs" onClick={(e) => e.stopPropagation()}>
            <MessageMenuItems {...props} onOpenPicker={() => setPickerOpen(true)} onOpenNote={() => setNoteOpen(true)} />
          </DropdownMenuContent>
        </DropdownMenu>
        {onReact && pickerOpen && (
          <EmojiPickerContent
            side="bottom"
            onPick={(emoji) => {
              setPickerOpen(false);
              onReact(emoji);
            }}
          />
        )}
      </Popover>
      {noteOpen && flowMessageId && (
        <NoteDialog flowMessageId={flowMessageId} conversationId={conversationId} onClose={() => setNoteOpen(false)} />
      )}
    </>
  );
}

function MessageMenuItems({
  flowMessageId,
  conversationId,
  messageText,
  origin,
  forwarded,
  onReply,
  replyInThread,
  onReact,
  onForward,
  onTaskIt,
  onEditName,
  onDelete,
  onOpenPicker,
  onOpenNote,
}: MessageActionsMenuProps & { onOpenPicker: () => void; onOpenNote: () => void }) {
  const isAdvanced = useIsAdvanced();
  const { isFavorited, toggleFavorite } = useFavorites();
  const worker = useCurrentWorker(conversationId);
  const favorited = flowMessageId ? !!isFavorited('flow_message', flowMessageId) : false;
  const showNote = !!flowMessageId && !!worker && isAdvanced;
  const WorkerIcon = workerIcon(worker?.worker_type ?? undefined);
  const conversing = !!(onReply || onReact);
  const sharing = !!(onForward || onTaskIt || flowMessageId);
  const managing = !!(onEditName || onDelete);

  return (
    <>
      {(origin?.kind || forwarded) && (
        <>
          <DropdownMenuLabel className="flex items-center gap-2 py-1 text-[11px] font-normal text-muted-foreground">
            <ChannelBadge origin={origin} />
            {forwarded && (
              <span className="inline-flex items-center gap-1 italic" data-testid="message-forwarded-marker">
                <Forward className="h-3 w-3" />
                <Trans>Forwarded from another conversation</Trans>
              </span>
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
        </>
      )}
      {onReply && (
        <DropdownMenuItem onSelect={onReply} data-testid="message-reply">
          <Reply className={ITEM_ICON} />
          {replyInThread ? <Trans>Reply in thread</Trans> : <Trans>Reply</Trans>}
        </DropdownMenuItem>
      )}
      {onReact && (
        <DropdownMenuItem onSelect={onOpenPicker} data-testid="message-react">
          <SmilePlus className={ITEM_ICON} />
          <Trans>React</Trans>
        </DropdownMenuItem>
      )}
      {conversing && sharing && <DropdownMenuSeparator />}
      {onForward && (
        <DropdownMenuItem onSelect={onForward} data-testid="message-forward">
          <Forward className={`${ITEM_ICON} rtl:-scale-x-100`} />
          <Trans>Forward</Trans>
        </DropdownMenuItem>
      )}
      {onTaskIt && (
        <DropdownMenuItem onSelect={onTaskIt} title={taskItHint()} data-testid="message-task-it">
          <TaskItIcon className={ITEM_ICON} />
          <Trans>Task it</Trans>
        </DropdownMenuItem>
      )}
      {flowMessageId && (
        <DropdownMenuItem asChild data-testid="message-download">
          <a href={localBundleUrl(flowMessageId)} download>
            <Download className={ITEM_ICON} />
            <Trans>Download message</Trans>
          </a>
        </DropdownMenuItem>
      )}
      {showNote && (
        <DropdownMenuItem onSelect={onOpenNote} data-testid="message-append-current">
          <WorkerIcon className={ITEM_ICON} />
          <Trans>Add a note to the running session</Trans>
        </DropdownMenuItem>
      )}
      {flowMessageId && (
        <DropdownMenuItem
          onSelect={() =>
            void toggleFavorite({
              entityType: 'flow_message',
              entityId: flowMessageId,
              title: firstWords(messageText, 10) || `Message ${flowMessageId.slice(0, 8)}`,
            })
          }
          data-testid="message-favorite"
        >
          <Star className={`${ITEM_ICON} ${favorited ? 'fill-current text-amber-500' : ''}`} />
          {favorited ? <Trans>Remove from favorites</Trans> : <Trans>Add to favorites</Trans>}
        </DropdownMenuItem>
      )}
      {managing && (conversing || sharing) && <DropdownMenuSeparator />}
      {onEditName && (
        <DropdownMenuItem onSelect={onEditName} data-testid="message-edit-name">
          <Pencil className={ITEM_ICON} />
          <Trans>Edit name</Trans>
        </DropdownMenuItem>
      )}
      {onDelete && (
        <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive" data-testid="message-delete">
          <Trash2 className="h-3.5 w-3.5" />
          <Trans>Delete message</Trans>
        </DropdownMenuItem>
      )}
    </>
  );
}

/** "Add a note to the running session": appended to the current worker's queue, tagged with the message. */
function NoteDialog({
  flowMessageId,
  conversationId,
  onClose,
}: {
  flowMessageId: string;
  conversationId?: string;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const worker = useCurrentWorker(conversationId);
  return (
    <InputDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t`Add to the running session`}
      description={t`Appended to the current worker's prompt queue, tagged with this message.`}
      placeholder={t`What should the worker do with this message?`}
      confirmLabel={t`Add to queue`}
      onConfirm={(value) => {
        worker
          ?.enqueue(`Re message ${flowMessageId}:\n${value.trim()}`, 'ui')
          .catch((err: unknown) => console.error('[MessageActionsMenu] enqueue failed', err));
      }}
    />
  );
}
