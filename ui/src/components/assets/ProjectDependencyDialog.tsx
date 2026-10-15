import React, { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { isValidUUIDv4, type Project } from '@sdk';
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

/** What a picked project is saved as: its hub id when it is published (fetched wherever this
 *  project opens), else its folder on this machine. Null when it has neither. */
export function dependencySourceFor(project: Pick<Project, 'id' | 'hub_published_at' | 'fs_storage_mount_path'>): string | null {
  if (project.hub_published_at) return `hub:${project.id}`;
  return project.fs_storage_mount_path || null;
}

interface ProjectDependencyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The project the dependency is added to — never offered as its own. */
  excludeProjectId?: string | null;
  /** Gets one source per chosen project — `hub:<id>` or a folder path. Awaited:
   *  the dialog stays up (with a spinner) until it settles, and shows a
   *  rejection's message. */
  onSubmit: (sources: string[]) => Promise<void>;
}

/**
 * Pick the projects to depend on, from ONE list: every project this desk knows
 * (the ones on the hub marked), plus a box for a hub project that is not on
 * this machine yet (a bare id, a `hub:<id>` source or a hub link).
 */
export function ProjectDependencyDialog({
  open,
  onOpenChange,
  excludeProjectId,
  onSubmit,
}: ProjectDependencyDialogProps): React.ReactElement {
  const { t } = useLingui();
  const [value, setValue] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { projects } = useProjects({ enabled: open });
  const offered = useMemo(
    () => (projects ?? []).filter((p) => !p.hidden && p.id !== excludeProjectId && dependencySourceFor(p)),
    [projects, excludeProjectId],
  );

  useEffect(() => {
    if (!open) {
      setValue('');
      setPicked([]);
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const pastedId = hubProjectIdFrom(value);
  const sources = useMemo(() => {
    const out = offered.filter((p) => picked.includes(p.id)).map((p) => dependencySourceFor(p)!);
    if (pastedId && !out.includes(`hub:${pastedId}`)) out.push(`hub:${pastedId}`);
    return out;
  }, [offered, picked, pastedId]);

  const toggle = (id: string) => setPicked((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(sources);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md" data-testid="project-dependency-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add project</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>A project on the hub is fetched wherever this project opens; any other is used from its folder on this computer.</Trans>
          </DialogDescription>
        </DialogHeader>
        {offered.length > 0 && (
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto" data-testid="project-dependency-projects">
            {offered.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={busy}
                aria-pressed={picked.includes(p.id)}
                onClick={() => toggle(p.id)}
                data-testid="project-dependency-project"
                className={`flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-left text-sm transition-colors ${
                  picked.includes(p.id)
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                }`}
              >
                <span className="truncate">{p.name || p.id}</span>
                {p.hub_published_at && (
                  <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-foreground">
                    <Trans>On hub</Trans>
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t`Not listed? Paste a hub project id or link`}
          disabled={busy}
          data-testid="project-dependency-input"
          aria-invalid={!!value.trim() && !pastedId}
        />
        {value.trim() && !pastedId && (
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
          <Button onClick={() => void submit()} disabled={!sources.length || busy} data-testid="project-dependency-submit">
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <Trans>Add</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
