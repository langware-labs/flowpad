import { Button } from '@src/components/ui/button';
import { deriveConversationTitle } from '@src/components/conversation/conversation-title';
import { useRecentConversations } from '@src/hooks/use-recent-conversations';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { EyeOff, Forward } from 'lucide-react';
import { useState } from 'react';

interface DiagnosisActionButtonsProps {
  /** The suggested support conversation — "Report issue" sends here; excluded from the Forward list. */
  suggestedConversationId?: string;
  busy?: boolean;
  error?: string;
  /** Dismiss the diagnosis surface (Feed card: dismiss the entry; modal: close). */
  onDismiss: () => void;
  /** Send the report to a conversation — used by both "Report issue" and a Forward pick. */
  onReport: (conversationId: string) => void;
}

/**
 * The action row at the bottom of a diagnosis surface: Dismiss / Report issue /
 * Forward (with a recent-conversation picker). Shared between the Home-Feed
 * `FeedEntryCard` and the UI diagnose modals so both render and behave identically;
 * the data/mutation wiring lives in each caller's `onDismiss` / `onReport`.
 */
export function DiagnosisActionButtons({
  suggestedConversationId,
  busy,
  error,
  onDismiss,
  onReport,
}: DiagnosisActionButtonsProps) {
  const [forwardOpen, setForwardOpen] = useState(false);
  // Forward target list: most recent conversations, fetched only while open. The
  // suggested support conversation is excluded — "Report issue" already targets it.
  const conversations = useRecentConversations(forwardOpen, {
    excludeId: suggestedConversationId,
  });

  return (
    <>
      <div className="mt-2 flex shrink-0 items-center gap-2">
        <button
          type="button"
          aria-label="Dismiss"
          title="Dismiss"
          disabled={busy}
          onClick={onDismiss}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <EyeOff className="h-3.5 w-3.5" />
        </button>
        <Button
          type="button"
          size="sm"
          disabled={busy || !suggestedConversationId}
          onClick={() => suggestedConversationId && onReport(suggestedConversationId)}
          className="h-6 px-2 text-xs"
        >
          Report issue
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          aria-expanded={forwardOpen}
          onClick={() => setForwardOpen((v) => !v)}
          className="h-6 gap-1 px-2 text-xs"
          data-testid="feed-forward-toggle"
        >
          <Forward className="h-3.5 w-3.5" />
          Forward
        </Button>
      </div>

      {forwardOpen && (
        <ul className="mt-2 flex flex-col gap-1" data-testid="feed-forward-conversations">
          {conversations.length === 0 ? (
            <li className="px-2 py-1 text-xs text-muted-foreground">No conversations yet.</li>
          ) : (
            conversations.map((conv) => (
              <li key={conv.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onReport(conv.id)}
                  className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted/50 disabled:pointer-events-none disabled:opacity-50"
                  data-testid={`feed-forward-conv-${conv.id}`}
                >
                  <span className="flex-1 truncate text-foreground">
                    {deriveConversationTitle(conv)}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {formatTimeAgo(
                      conv.updated_date ? new Date(conv.updated_date).toISOString() : null,
                    ) ?? ''}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}

      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </>
  );
}
