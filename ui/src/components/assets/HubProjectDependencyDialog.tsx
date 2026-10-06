import React, { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { isValidUUIDv4 } from '@sdk';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { useProjects } from '@src/hooks/use-projects';

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The hub project id a pasted value names — a bare id, a `hub:<id>` source,
 *  or a hub link carrying one — or null. */
export function hubProjectIdFrom(text: string): string | null {
  const raw = text.trim().replace(/^hub:/i, '');
  if (isValidUUIDv4(raw)) return raw.toLowerCase();
  const found = raw.match(UUID_IN_TEXT)?.[0];
  return found && isValidUUIDv4(found) ? found.toLowerCase() : null;
}

interface HubProjectDependencyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The project the dependency is added to — never offered as its own. */
  excludeProjectId?: string | null;
  /** Gets the `hub:<id>` source. Awaited: the dialog stays up (with a spinner)
   *  until it settles, and shows a rejection's message. */
  onSubmit: (source: string) => Promise<void>;
}

/**
 * Pick a hub project to depend on: one of the projects published to the hub
 * that this desk already knows, or any hub project id pasted in (a bare id, a
 * `hub:<id>` source or a hub link).
 */
export function HubProjectDependencyDialog({
  open,
  onOpenChange,
  excludeProjectId,
  onSubmit,
}: HubProjectDependencyDialogProps): React.ReactElement {
  const { t } = useLingui();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { projects } = useProjects({ enabled: open });
  const published = useMemo(
    () => (projects ?? []).filter((p) => !!p.hub_published_at && p.id !== excludeProjectId),
    [projects, excludeProjectId],
  );

  useEffect(() => {
    if (!open) {
      setValue('');
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const projectId = hubProjectIdFrom(value);

  const submit = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(`hub:${id}`);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md" data-testid="hub-dependency-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add hub project</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>A project on the hub, fetched by its id wherever this project opens.</Trans>
          </DialogDescription>
        </DialogHeader>
        {published.length > 0 && (
          <div className="flex max-h-48 flex-col gap-1 overflow-y-auto" data-testid="hub-dependency-projects">
            {published.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={busy}
                onClick={() => setValue(p.id)}
                data-testid="hub-dependency-project"
                className={`truncate rounded-md border px-3 py-1.5 text-left text-sm transition-colors ${
                  projectId === p.id
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                }`}
              >
                {p.name || p.id}
              </button>
            ))}
          </div>
        )}
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t`Hub project id or link`}
          disabled={busy}
          data-testid="hub-dependency-input"
          aria-invalid={!!value.trim() && !projectId}
        />
        {value.trim() && !projectId && (
          <p className="text-xs text-muted-foreground">
            <Trans>That doesn't name a hub project — paste its id or a link to it.</Trans>
          </p>
        )}
        {error && (
          <p className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-xs" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            onClick={() => projectId && void submit(projectId)}
            disabled={!projectId || busy}
            data-testid="hub-dependency-submit"
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <Trans>Add</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
