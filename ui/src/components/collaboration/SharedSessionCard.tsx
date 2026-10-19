import { cn } from '@src/lib/utils';
import { ArrowRight, Monitor } from 'lucide-react';
import type { SharedSessionRow } from '@src/hooks/useRemoteWorkerSessions';

const STATUS_DOT: Record<string, string> = {
  running: 'bg-green-500 animate-pulse',
  idle: 'bg-muted-foreground',
  ended: 'bg-red-500',
  error: 'bg-red-500',
};

interface Props {
  session: SharedSessionRow;
  active: boolean;
  onClick: () => void;
}

/** One shared session: the guest works on the host's machine. host ⇄ guest + status. */
export function SharedSessionCard({ session, active, onClick }: Props) {
  const dot = STATUS_DOT[session.status] ?? 'bg-muted-foreground';
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-start transition-colors',
        active ? 'border-primary bg-muted' : 'border-transparent hover:bg-muted',
      )}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className={cn('h-2 w-2 flex-shrink-0 rounded-full', dot)} />
        <span className="min-w-0 truncate font-medium">{session.guestName}</span>
        <ArrowRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        <Monitor className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-muted-foreground">{session.hostName}</span>
      </div>
      <div className="ps-4 text-xs capitalize text-muted-foreground">{session.status}</div>
    </button>
  );
}
