import { useMemo, useState } from 'react';
import { HeartHandshake, MessagesSquare } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import type { TypeId } from '@sdk';
import { ShareToConversationDialog } from '@src/components/share-to-conversation/ShareToConversationDialog';
import { collaborateShareSource } from '@src/hooks/share-sources';
import { useCollaborationForProject } from '@src/hooks/useCollaborationForProject';
import { ConversationView } from '@src/components/conversation/ConversationView';
import { Dialog, DialogContent, DialogTitle } from '@src/components/ui/dialog';

/**
 * The vibe workspace's "Collaborate" affordance, sitting next to the "Recent"
 * pill. Before anyone is invited it opens the standard share modal reframed for
 * collaboration (title + message + recipient + "attach session transcript",
 * the exact agentic-process transcript behavior). Once a collaboration
 * conversation exists for this project the icon flips to a conversation icon
 * that opens that conversation as an in-context modal overlay — no navigation,
 * so the user keeps their work.
 */
export function VibeCollaborateButton({
  projectId,
  sessionTypeId,
}: {
  projectId: string | null;
  /** The active vibe session process — supplies the transcript. Null before a
   *  session starts (the modal still works, title-only). */
  sessionTypeId: TypeId | null;
}) {
  const { t } = useLingui();
  const [shareOpen, setShareOpen] = useState(false);
  const [convOpen, setConvOpen] = useState(false);
  const { conversationId } = useCollaborationForProject(projectId);
  const collaborating = conversationId != null;

  // Key the source on the session id string, not the TypeId object identity
  // (which can be a fresh instance each render), so the dialog isn't handed a
  // new source mid-share.
  const sessionKey = sessionTypeId?.toString() ?? null;
  const source = useMemo(
    () => collaborateShareSource(sessionTypeId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionKey],
  );

  const iconBtn =
    'flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <>
      <button
        type="button"
        onClick={() => (collaborating ? setConvOpen(true) : setShareOpen(true))}
        title={collaborating ? t`Open collaboration` : t`Collaborate`}
        className={iconBtn}
        data-testid={collaborating ? 'vibe-collaborate-open' : 'vibe-collaborate'}
      >
        {collaborating ? (
          <MessagesSquare className="h-3.5 w-3.5" />
        ) : (
          <HeartHandshake className="h-3.5 w-3.5" />
        )}
      </button>

      {shareOpen && (
        <ShareToConversationDialog
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          source={source}
          projectId={projectId}
          titlePlaceholder={t`What do you want to collaborate on?`}
          submitLabel={t`Send invite`}
          associateProjectOnRemote
          onShared={() => setShareOpen(false)}
        />
      )}

      {convOpen && conversationId && (
        <Dialog open={convOpen} onOpenChange={setConvOpen}>
          <DialogContent className="flex h-[80vh] max-w-3xl flex-col overflow-hidden p-0">
            <DialogTitle className="sr-only">{t`Collaboration`}</DialogTitle>
            <div className="min-h-0 flex-1 overflow-hidden">
              <ConversationView conversationId={conversationId} />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
