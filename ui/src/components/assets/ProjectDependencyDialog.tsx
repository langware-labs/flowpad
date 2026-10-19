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
import { useProjectListSource } from '@src/components/open-project-component/use-project-list-source';
import { ProjectSelector } from '@src/components/project-selector/ProjectSelector';
import { projectListToSelectorItems } from '@src/components/project-selector/project-items';
import { canonicalPath } from '@src/components/project-selector/use-ensure-project';
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
 * Pick the project to depend on from the same list (and `ProjectSelector`) the
 * Open project screen uses — every project on this machine, or on a hub-only
 * server the hub's list — plus a box for a hub project not listed (a bare id,
 * a `hub:<id>` source or a hub link).
 */
export function ProjectDependencyDialog({
  open,
  onOpenChange,
  excludeProjectId,
  onSubmit,
}: ProjectDependencyDialogProps): React.ReactElement {
  const { t } = useLingui();
  const [value, setValue] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { projects: listed, isLoading, hub } = useProjectListSource({ enabled: open });
  const { projects: entities } = useProjects({ enabled: open && !hub });

  // Rows are the shared project list; each maps to the source it is saved as.
  // On a hub every row is a hub project; on a desk a row is its folder, unless
  // the entity on that folder is published — then it is its hub id.
  const { items, sourceById } = useMemo(() => {
    const sourceById = new Map<string, string>();
    if (hub) {
      const rows = listed.filter((p) => p.id !== excludeProjectId);
      for (const p of rows) sourceById.set(p.id, `hub:${p.id}`);
      return {
        items: rows.map((p) => ({ id: p.id, name: p.name || p.id, modifiedAt: p.modified_at ?? null })),
        sourceById,
      };
    }
    const entityByPath = new Map(
      (entities ?? []).filter((p) => p.fs_storage_mount_path).map((p) => [canonicalPath(p.fs_storage_mount_path!), p]),
    );
    const items = projectListToSelectorItems(listed).filter((item) => entityByPath.get(item.id)?.id !== excludeProjectId);
    for (const item of items) {
      const entity = entityByPath.get(item.id);
      sourceById.set(item.id, (entity && dependencySourceFor(entity)) || item.path!);
    }
    return { items, sourceById };
  }, [hub, listed, entities, excludeProjectId]);

  useEffect(() => {
    if (!open) {
      setValue('');
      setPicked(null);
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const pastedId = hubProjectIdFrom(value);
  const pickedSource = picked ? sourceById.get(picked) : undefined;
  const sources = [...new Set([pickedSource, pastedId && `hub:${pastedId}`].filter((x): x is string => !!x))];

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
        <div className="h-72 min-w-0 overflow-hidden" data-testid="project-dependency-projects">
          <ProjectSelector
            projects={items}
            selectedId={picked}
            onSelect={setPicked}
            isLoading={isLoading}
          />
        </div>
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
