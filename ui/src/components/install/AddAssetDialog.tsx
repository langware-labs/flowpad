import { dataContext, Project, type InstallRequest } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { iconForType, labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { getProjectDisplayName, useProjectList } from '@src/hooks/use-claude-projects';
import { describeApiError } from '@src/lib/error-message';
import { openDisplayTarget } from '@src/navigation/open-display-target';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { Loader2, PackagePlus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { closeInstallRequest, useInstallRequestStore } from './install-request-store';

/**
 * "Add asset" — the desktop half of one-click install. Opens when the hub
 * relays an `install_request` (see `use-ui-command-listener`). Shows the
 * published row and lets the person pick the project it goes into (the
 * active project by default), then calls the desk's `install-published`
 * action: copy from the row's origin, index keeping the publisher's id,
 * record in `deps.json`. What opens afterwards is the backend's DisplayTarget.
 */
export function AddAssetDialogRoot() {
  const open = useInstallRequestStore((s) => s.open);
  const request = useInstallRequestStore((s) => s.payload);
  const setOpen = useInstallRequestStore((s) => s.setOpen);
  if (!open || !request) return null;
  return <AddAssetDialog request={request} onOpenChange={setOpen} />;
}

export function AddAssetDialog({ request, onOpenChange }: { request: InstallRequest; onOpenChange: (open: boolean) => void }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { projects } = useProjectList();
  const activeId = dataContext.project?.id ?? null;
  const [projectId, setProjectId] = useState<string | null>(activeId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  useEffect(() => {
    // A new request re-defaults to the active project.
    setProjectId(activeId);
    setError(null);
  }, [request.typeid, activeId]);

  const options = useMemo(() => {
    const list = projects.map((p) => ({ id: p.id, label: getProjectDisplayName(p) }));
    if (activeId && !list.some((p) => p.id === activeId)) {
      list.unshift({ id: activeId, label: dataContext.project?.name ?? t`Current project` });
    }
    return list;
  }, [projects, activeId, t]);

  const Icon = iconForType(request.type);
  const install = async (overwrite = false) => {
    if (!projectId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await new Project({ id: projectId, type: Project.type }).installPublished(request, overwrite);
      notify.success({ title: request.name || request.typeid, message: t`Added to the project.` });
      closeInstallRequest();
      openDisplayTarget(result.show as never, navigation);
    } catch (err) {
      setError(describeApiError(err, t`The asset was not added.`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="add-asset-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackagePlus className="h-4 w-4" />
            <Trans>Add asset</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Published by {request.source_project_name || t`another project`} — install a copy into one of yours.</Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3" data-testid="add-asset-card">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary/80 to-primary/40 text-primary-foreground">
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="truncate font-semibold" data-testid="add-asset-name">{request.name || request.typeid}</div>
            <div className="text-[11px] text-muted-foreground">{labelForType(request.type)}</div>
            {request.description && <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{request.description}</p>}
          </div>
        </div>

        <label className="space-y-1.5 text-sm">
          <span className="text-xs font-medium text-muted-foreground">
            <Trans>Add to project</Trans>
          </span>
          <Select value={projectId ?? undefined} onValueChange={setProjectId}>
            <SelectTrigger data-testid="add-asset-project">
              <SelectValue placeholder={t`Choose a project`} />
            </SelectTrigger>
            <SelectContent>
              {options.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        {error && (
          <p className="text-sm text-destructive" data-testid="add-asset-error">
            {error.message}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            <Trans>Not now</Trans>
          </Button>
          {error?.code === 'exists' ? (
            <Button onClick={() => void install(true)} disabled={busy || !projectId} data-testid="add-asset-overwrite">
              {busy && <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" />}
              <Trans>Replace existing</Trans>
            </Button>
          ) : (
            <Button onClick={() => void install(false)} disabled={busy || !projectId} data-testid="add-asset-install">
              {busy && <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" />}
              <Trans>Install</Trans>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
