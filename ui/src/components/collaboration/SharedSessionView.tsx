import { RemoteWorkerSession, TypeId } from '@sdk';
import { Trans } from '@lingui/react/macro';
import { PlugZap, Radio } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Button } from '@src/components/ui/button';
import { ConversationView } from '@src/components/conversation/ConversationView';
import { useAuth } from '@src/hooks/useAuth';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';

interface Props {
  sessionId: string;
}

/**
 * A shared session's detail: the guest drives work on the host's machine, and
 * both sides watch the prompt/PromptResult turn exchange as a chat. The HOST
 * (the machine being driven) sees a banner + Disconnect; the GUEST sees the
 * same chat + a "running on <host>'s machine" note.
 */
export function SharedSessionView({ sessionId }: Props) {
  const { user } = useAuth();
  const sessionTypeId = useMemo(() => {
    try {
      return new TypeId(RemoteWorkerSession.type, sessionId);
    } catch {
      return null;
    }
  }, [sessionId]);
  const { data: session } = useEntity<RemoteWorkerSession>(sessionTypeId, { watch: true });
  // Denormalized on the session at write time — no cross-roster resolution.
  const guestName = session?.guest_name ?? session?.guest_user_id ?? 'someone';
  const [disconnecting, setDisconnecting] = useState(false);

  const handleDisconnect = useCallback(async () => {
    if (!session) return;
    setDisconnecting(true);
    try {
      await session.disconnect();
    } finally {
      setDisconnecting(false);
    }
  }, [session]);

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>Loading session…</Trans>
      </div>
    );
  }

  const isHost = session.isHost(user?.id ?? null);
  const ended = session.status === 'ended';
  const conversationId = session.conversation_id;

  return (
    <div className="flex h-full flex-col">
      {isHost ? (
        <div className="sticky top-0 z-10 flex flex-shrink-0 items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2">
          <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
            <Radio className="h-4 w-4 flex-shrink-0" />
            <span>
              <Trans>This session is running remotely by {guestName} on your machine.</Trans>
            </span>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDisconnect}
            disabled={disconnecting || ended}
          >
            <PlugZap className="mr-1.5 h-4 w-4" />
            {ended ? <Trans>Disconnected</Trans> : <Trans>Disconnect</Trans>}
          </Button>
        </div>
      ) : (
        <div className="sticky top-0 z-10 flex flex-shrink-0 items-center gap-2 border-b bg-background px-4 py-2 text-xs text-muted-foreground">
          <Radio className="h-3.5 w-3.5 flex-shrink-0" />
          <Trans>Running on the host's machine · status: {session.status}</Trans>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {conversationId ? (
          <ConversationView conversationId={conversationId} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Trans>This session has no bound conversation.</Trans>
          </div>
        )}
      </div>
    </div>
  );
}
