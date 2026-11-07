import { useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { Loader2, Paperclip } from 'lucide-react';
import { ActionInfo, dataManager } from '@sdk';
import type { Attachment } from '@sdk/entities/flow-message';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { dockPointerForLocalFile } from '@src/components/conversation/attachment-url';

/** One file in a conversation, as the backend's `attachments` action lists it. */
export interface ConversationAttachment {
  message_id: string;
  ts: string | null;
  attachment: Attachment;
}

/** The one request the paperclip makes: every file across the conversation, newest first. */
export async function fetchConversationAttachments(conversationId: string): Promise<ConversationAttachment[]> {
  const action = new ActionInfo('attachments', 'conversation', conversationId, 'GET');
  return (await dataManager.callAction<null, ConversationAttachment[]>(action)) ?? [];
}

const fileName = (a: Attachment) => a.data.split('/').pop() || a.data;

/** The inbox row's paperclip: hidden at 0, else the count; opening it lists the files.
 *  Clicking a file does what clicking its chip in the message does — open it when it is
 *  on this machine — otherwise opens the conversation at that message, where it downloads. */
export function ConversationAttachmentsButton({ conversationId, count }: { conversationId: string; count: number }) {
  const { navigation } = useDockNavigation();
  const [items, setItems] = useState<ConversationAttachment[] | null>(null);
  if (count <= 0) return null;

  const onOpenChange = (open: boolean) => {
    if (open) void fetchConversationAttachments(conversationId).then(setItems);
    else setItems(null);
  };
  const openItem = (item: ConversationAttachment) => {
    const local = item.attachment.local_path;
    navigation.openDock(
      local ? dockPointerForLocalFile(local) : DockPointer.forConversation(conversationId, { messageId: item.message_id }),
    );
  };

  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="stream-inbox-row-attachments"
          onClick={(e) => e.stopPropagation()}
          className="ms-1 inline-flex shrink-0 items-center gap-0.5 font-normal text-muted-foreground hover:text-foreground"
        >
          <Paperclip className="h-3.5 w-3.5" />
          <span className="tabular-nums">{count}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1" onClick={(e) => e.stopPropagation()}>
        {items === null ? (
          <div className="flex justify-center p-2">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="p-2 text-xs text-muted-foreground">
            <Trans>No attachments</Trans>
          </div>
        ) : (
          items.map((item) => (
            <button
              key={`${item.message_id}:${item.attachment.data}`}
              type="button"
              data-testid="stream-inbox-attachment-item"
              onClick={() => openItem(item)}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-start text-xs hover:bg-accent"
            >
              <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{fileName(item.attachment)}</span>
              {item.ts && (
                <span className="shrink-0 text-muted-foreground">{new Date(item.ts).toLocaleDateString()}</span>
              )}
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}
