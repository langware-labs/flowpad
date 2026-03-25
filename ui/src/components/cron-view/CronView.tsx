import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { CronEvent, type ICronEvent } from '@sdk';
import { CronEventCard } from './CronEventCard';
import { CronForm } from './CronForm';

type FormMode = { kind: 'create' } | { kind: 'edit'; event: ICronEvent } | null;

function nextDefaultName(events: ICronEvent[]): string {
  const base = 'Today';
  const existing = new Set(events.map((e) => e.name));
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

export function CronView() {
  const [events, setEvents] = useState<ICronEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [formMode, setFormMode] = useState<FormMode>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchEvents = useCallback(async () => {
    try {
      const list = await CronEvent.list();
      setEvents(list);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchEvents(); }, [fetchEvents]);

  const handleCreate = async (data: Partial<ICronEvent>) => {
    setSubmitting(true);
    try {
      const created = await CronEvent.create(data);
      setEvents((prev) => [...prev, created]);
      setFormMode(null);
    } catch (e) {
      console.error('CronEvent create error:', e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = async (data: Partial<ICronEvent>) => {
    if (formMode?.kind !== 'edit') return;
    setSubmitting(true);
    try {
      const entity = new CronEvent(formMode.event);
      const updated = await entity.updateFields(data);
      setEvents((prev) => prev.map((e) => e.id === updated.id ? updated : e));
      setFormMode(null);
    } catch (e) {
      console.error('CronEvent update error:', e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleted = (id: string) => {
    setEvents((prev) => prev.filter((e) => e.id !== id));
  };

  const handleUpdated = (updated: ICronEvent) => {
    setEvents((prev) => prev.map((e) => e.id === updated.id ? updated : e));
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <span className="text-sm font-medium">Scheduled Jobs</span>
        {events.length > 0 && (
          <Badge variant="secondary" className="text-[10px]">{events.length}</Badge>
        )}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => setFormMode({ kind: 'create' })}
        >
          + New
        </Button>
      </div>

      {/* Inline form */}
      {formMode && (
        <div className="border-b bg-muted/30">
          <CronForm
            initial={formMode.kind === 'edit' ? formMode.event : {}}
            defaultName={formMode.kind === 'create' ? nextDefaultName(events) : undefined}
            onSubmit={formMode.kind === 'create' ? handleCreate : handleEdit}
            onCancel={() => setFormMode(null)}
            submitting={submitting}
          />
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-auto p-4">
        {events.length === 0 && formMode === null ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <p>No scheduled jobs yet.</p>
            <Button size="sm" variant="outline" onClick={() => setFormMode({ kind: 'create' })}>
              + New Job
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {events.map((event) => (
              <CronEventCard
                key={event.id}
                event={event}
                onEdit={(e) => setFormMode({ kind: 'edit', event: e })}
                onDeleted={handleDeleted}
                onUpdated={handleUpdated}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
