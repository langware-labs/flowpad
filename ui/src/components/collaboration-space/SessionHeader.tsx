import type { CollaborationSession } from '@sdk';
import { Button } from '@src/components/ui/button';
import { useToast } from '@src/hooks/use-toast';
import { Radio, Square } from 'lucide-react';

interface Props {
  session: CollaborationSession;
  isHost: boolean;
  onEnded?: () => void;
}

function formatStarted(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function SessionHeader({ session, isHost, onEnded }: Props) {
  const { toast } = useToast();
  const live = session.status === 'active';

  const handleEnd = async () => {
    try {
      await session.end();
      toast({ title: 'Session ended' });
      onEnded?.();
    } catch (err) {
      console.error('[SessionHeader] end failed', err);
      toast({ title: 'Could not end session', description: String((err as Error).message ?? err) });
    }
  };

  return (
    <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b bg-muted/30 px-3 text-xs">
      {live ? (
        <Radio className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <Square className="h-3.5 w-3.5 text-muted-foreground" />
      )}
      <span className="font-medium text-foreground">{session.displayName}</span>
      <span className="text-muted-foreground">· started {formatStarted(session.started_at)}</span>
      <span className="ml-auto text-muted-foreground">
        {(session.members?.length ?? 0)} {session.members?.length === 1 ? 'member' : 'members'}
      </span>
      {isHost && live && (
        <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => void handleEnd()}>
          End session
        </Button>
      )}
    </div>
  );
}
