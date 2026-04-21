import type { CollaborationSession } from '@sdk';
import { Button } from '@src/components/ui/button';
import { useToast } from '@src/hooks/use-toast';
import { Radio, Sparkles, Square } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

interface Props {
  session: CollaborationSession;
  isHost: boolean;
  /** True when the session belongs to an SDK-shipped system project. */
  isSupport?: boolean;
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

export function SessionHeader({ session, isHost, isSupport = false, onEnded }: Props) {
  const { toast } = useToast();
  const live = session.status === 'active';
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(session.displayName);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

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

  const startEdit = () => {
    setDraftName(session.name ?? session.displayName);
    setEditing(true);
  };

  const commit = async () => {
    const trimmed = draftName.trim();
    setEditing(false);
    const next = trimmed || null;
    if ((session.name ?? null) === next) return;
    try {
      session.name = next;
      await session.save();
      toast({ title: 'Session renamed', description: trimmed || '(cleared)' });
    } catch (err) {
      console.error('[SessionHeader] rename failed', err);
      toast({ title: 'Rename failed', description: String((err as Error).message ?? err) });
    }
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
      setDraftName(session.displayName);
    }
  };

  return (
    <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b bg-muted/30 px-3 text-xs">
      {live ? (
        <Radio className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <Square className="h-3.5 w-3.5 text-muted-foreground" />
      )}
      {editing ? (
        <input
          ref={inputRef}
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={handleKey}
          onBlur={() => void commit()}
          className="min-w-[160px] max-w-[360px] rounded border border-primary/40 bg-background px-2 py-0.5 text-xs font-medium outline-none focus:border-primary"
        />
      ) : (
        <button
          type="button"
          onClick={startEdit}
          className="rounded px-1 font-medium text-foreground hover:bg-muted"
          title="Click to rename session"
        >
          {session.displayName}
        </button>
      )}
      <span className="text-muted-foreground">· started {formatStarted(session.started_at)}</span>
      {isSupport && (
        <span
          className="flex items-center gap-1 rounded-full border border-border bg-muted px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground"
          title="Session hosted by the Flowpad team"
        >
          <Sparkles className="h-2.5 w-2.5" />
          Support session
        </span>
      )}
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
