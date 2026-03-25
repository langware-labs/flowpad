import { useState } from 'react';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { CronEvent, type ICronEvent } from '@sdk';

interface CronEventCardProps {
  event: ICronEvent;
  onEdit: (event: ICronEvent) => void;
  onDeleted: (id: string) => void;
  onUpdated: (event: ICronEvent) => void;
}

function formatDate(d?: Date | string | null): string {
  if (!d) return '—';
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toLocaleString();
}

export function CronEventCard({ event, onEdit, onDeleted, onUpdated }: CronEventCardProps) {
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleTest = async () => {
    if (!event.id) return;
    setTesting(true);
    try {
      const entity = new CronEvent(event);
      const result = await entity.test();
      onUpdated({ ...event, counter: result.counter, last_run: new Date() });
    } catch (e) {
      console.error('CronEvent test error:', e);
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async () => {
    if (!event.id) return;
    setDeleting(true);
    try {
      const entity = new CronEvent(event);
      await entity.remove();
      onDeleted(event.id);
    } catch (e) {
      console.error('CronEvent delete error:', e);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
      {/* Header row */}
      <div className="flex items-center gap-2">
        <span className="font-medium">{event.name}</span>
        <Badge variant={event.enabled ? 'default' : 'secondary'} className="text-[10px]">
          {event.enabled ? 'enabled' : 'paused'}
        </Badge>
        <Badge variant="outline" className="text-[10px]">
          {event.trigger_type ?? 'cron'}
        </Badge>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{event.expr}</span>
      </div>

      {/* Description */}
      {event.description && (
        <p className="text-[11px] text-muted-foreground">{event.description}</p>
      )}

      {/* Times */}
      <div className="flex gap-4 text-[11px] text-muted-foreground">
        <span>Next: {formatDate(event.next_run)}</span>
        <span>Last: {formatDate(event.last_run)}</span>
        <span className="ml-auto">
          Fired: <span className="font-semibold text-foreground">{event.counter ?? 0}</span>
        </span>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void handleTest()}
          disabled={testing || deleting}
        >
          {testing ? 'Firing...' : 'Test'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onEdit(event)}
          disabled={testing || deleting}
        >
          Edit
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void handleDelete()}
          disabled={testing || deleting}
          className="ml-auto text-destructive hover:text-destructive"
        >
          {deleting ? 'Deleting...' : 'Delete'}
        </Button>
      </div>
    </div>
  );
}
