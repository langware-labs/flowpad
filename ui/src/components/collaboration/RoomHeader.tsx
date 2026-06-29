import type { CollaborationRoom } from '@sdk';
import { Button } from '@src/components/ui/button';
import { notify } from '@src/notifications';
import { Radio, Sparkles, Square } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

interface Props {
  room: CollaborationRoom;
  isHost: boolean;
  /** True when the room belongs to an SDK-shipped system project. */
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

export function RoomHeader({ room, isHost, isSupport = false, onEnded }: Props) {
  const { t } = useLingui();
  const live = room.status === 'active';
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(room.displayName);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleEnd = async () => {
    try {
      await room.end();
      notify.success({ title: t`Room ended` });
      onEnded?.();
    } catch (err) {
      console.error('[RoomHeader] end failed', err);
      notify.info({ title: t`Could not end room`, message: String((err as Error).message ?? err) });
    }
  };

  const startEdit = () => {
    setDraftName(room.name ?? room.displayName);
    setEditing(true);
  };

  const commit = async () => {
    const trimmed = draftName.trim();
    setEditing(false);
    const next = trimmed || null;
    if ((room.name ?? null) === next) return;
    try {
      room.name = next;
      await room.save();
      notify.success({ title: t`Room renamed`, message: trimmed || '(cleared)' });
    } catch (err) {
      console.error('[RoomHeader] rename failed', err);
      notify.info({ title: t`Rename failed`, message: String((err as Error).message ?? err) });
    }
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
      setDraftName(room.displayName);
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
          title={t`Click to rename room`}
        >
          {room.displayName}
        </button>
      )}
      <span className="text-muted-foreground">· <Trans>started</Trans> {formatStarted(room.started_at)}</span>
      {isSupport && (
        <span
          className="flex items-center gap-1 rounded-full border border-border bg-muted px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground"
          title={t`Room hosted by the Flowpad team`}
        >
          <Sparkles className="h-2.5 w-2.5" />
          <Trans>Support room</Trans>
        </span>
      )}
      <span className="ml-auto text-muted-foreground">
        {(room.members?.length ?? 0)} {room.members?.length === 1 ? t`member` : t`members`}
      </span>
      {isHost && live && (
        <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => void handleEnd()}>
          <Trans>End room</Trans>
        </Button>
      )}
    </div>
  );
}
