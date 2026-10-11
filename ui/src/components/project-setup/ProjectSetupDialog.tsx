import { useCallback, useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  CredentialsSubview,
  Layout,
  Project,
  recheckProjectReadiness,
  setProjectReadiness,
  TypeId,
  type ProjectReadiness,
  type ProjectSetupRequirement,
  type ProjectSetupSkipScope,
} from '@sdk';
import { AlertTriangle, CheckCircle2, Info, Loader2, Package, Undo2, type LucideIcon } from 'lucide-react';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { AskForm } from '@src/components/ask/AskForm';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { useProjectSetupStore } from './project-setup-store';
import { SetupTreeView } from './SetupTreeView';
import { useSetupRun } from './use-setup-run';

/**
 * The project's setup, run in the app: what the footer's "Project setup required" opens.
 *
 * The run is the backend's (`POST project/<id>/setup` — the project's setup TREE, the same one `flow
 * project setup` runs): every credential, connection, source and web app, each after what it needs.
 * Closing this loses nothing: starting again picks up where it stopped, every step whose check already
 * holds skipped. While it runs, its questions are drawn in place (`useSetupRun`) — a secret masked, a
 * key file as a file picker — instead of the tab being sent to `win/ask`.
 */

/** A row's glyph is its record's type icon (the registry's); a dependency is the project's own, so its own glyph. */
function iconOf(req: ProjectSetupRequirement): LucideIcon {
  if (req.kind === 'dependency' || !req.typeid) return Package;
  return iconForType(new TypeId(req.typeid).type);
}

const rowKey = (req: ProjectSetupRequirement) => `${req.kind}-${req.typeid}-${req.name}`;

/**
 * Where a row opens: its own page with it selected — a credential (env or oauth) on the credentials page, a data
 * source on its page, a web app running; a dependency (not on this machine) on the project's page.
 */
export function pointerForRequirement(req: ProjectSetupRequirement, projectId: string): DockPointer | null {
  if (req.kind === 'pack') {
    return DockPointer.forCredentials(CredentialsSubview.CONNECTIONS, projectId, Layout.DOCK, req.typeid || undefined);
  }
  if (req.kind === 'source' && req.typeid) {
    return DockPointer.forDataSources({ section: 'source', id: new TypeId(req.typeid).id, tab: null });
  }
  if (req.kind === 'webapp' && req.typeid) return DockPointer.forAppEntity(new TypeId(req.typeid));
  if (req.kind === 'dependency') return DockPointer.forProject(projectId);
  return null;
}

/** A dependency, source or web app goes by its own name (its title is where it comes from); a credential by its title. */
const namesItself = (req: ProjectSetupRequirement) => req.kind === 'dependency' || req.kind === 'source' || req.kind === 'webapp';

/**
 * What a row says beside its name: why it is not ready, else what the credential is needed for, else what is
 * missing.
 */
function detailOf(req: ProjectSetupRequirement): string {
  if (namesItself(req)) return req.note || req.title;
  if (req.credential_kind === 'oauth') return req.note || req.needed_for || `connect ${req.title || req.name}`;
  return (
    req.needed_for ||
    req.vars
      .filter((v) => !v.present)
      .map((v) => v.label || v.env_var)
      .join(', ')
  );
}

/** The full reason a credential is needed — the popover behind the info glyph. */
function JustificationInfo({ req }: { req: ProjectSetupRequirement }) {
  const { t } = useLingui();
  if (!req.justification) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={own(() => undefined)}
          onKeyDown={(event) => event.stopPropagation()}
          className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground"
          aria-label={t`Why is this needed?`}
          data-testid={`project-setup-why-${req.name}`}
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 whitespace-pre-wrap text-xs"
        onClick={(event) => event.stopPropagation()}
        data-testid={`project-setup-why-text-${req.name}`}
      >
        {req.justification}
      </PopoverContent>
    </Popover>
  );
}

export function ProjectSetupDialogRoot() {
  const { open, payload, setOpen } = useProjectSetupStore();
  if (!payload) return null;
  return <ProjectSetupDialog projectId={payload.projectId} projectName={payload.projectName} open={open} onOpenChange={setOpen} />;
}

export function ProjectSetupDialog({
  projectId,
  projectName,
  open,
  onOpenChange,
}: {
  projectId: string;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const [readiness, setReadiness] = useState<ProjectReadiness | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  const { navigation } = useDockNavigation();


  const load = useCallback(async () => {
    setReadiness(await Project.setupRequirements(projectId));
  }, [projectId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // When the run ends, re-check the project here and everywhere it is shown.
  const setup = useSetupRun(projectId, '', async () => {
    await Promise.all([load(), recheckProjectReadiness()]);
  });

  const start = async () => {
    try {
      await setup.start();
    } catch (e) {
      notify.error({ title: errorMessage(e, t`Could not start the setup`) });
    }
  };

  /** The skip answers with the readiness that follows: the dialog and the footer take it as is. */
  const settle = (next: ProjectReadiness | null) => {
    setReadiness(next);
    if (next) setProjectReadiness(next);
  };

  const skip = async (req: ProjectSetupRequirement, scope: ProjectSetupSkipScope) => {
    const key = rowKey(req);
    setBusy(key);
    try {
      settle(await Project.skipSetup(projectId, req.typeid, scope, { name: req.name }));
      setChoosing(null);
    } catch (e) {
      notify.error({ title: errorMessage(e, t`Could not skip ${req.name}`) });
    } finally {
      setBusy(null);
    }
  };

  const unskip = async (req: ProjectSetupRequirement) => {
    setBusy(rowKey(req));
    try {
      settle(await Project.unskipSetup(projectId, req.typeid, req.name));
    } catch (e) {
      notify.error({ title: errorMessage(e, t`Could not undo the skip of ${req.name}`) });
    } finally {
      setBusy(null);
    }
  };

  // URL-first: a row's click only navigates; the page it opens selects the entry from the URL.
  const openRow = (req: ProjectSetupRequirement) => {
    const pointer = pointerForRequirement(req, projectId);
    if (!pointer) return;
    onOpenChange(false);
    navigation.openDock(pointer);
  };

  const running = setup.running;
  const questionId = setup.questionId;

  const row = (req: ProjectSetupRequirement, skipped = false) => (
    <RequirementRow
      key={rowKey(req)}
      req={req}
      skipped={skipped}
      running={running}
      busy={busy === rowKey(req)}
      choosing={choosing === rowKey(req)}
      onChoose={(on) => setChoosing(on ? rowKey(req) : null)}
      onSkip={(scope) => void skip(req, scope)}
      onUndo={() => void unskip(req)}
      onOpen={() => openRow(req)}
    />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="project-setup-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Set up {projectName}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              What this project needs before it can run here. Close it any time — starting again picks up where it
              stopped.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        {readiness?.ready ? (
          <p className="flex items-center gap-2 text-sm text-emerald-600" data-testid="project-setup-ready">
            <CheckCircle2 className="size-4" />
            <Trans>Everything required is set up.</Trans>
          </p>
        ) : (
          <Section title={t`Required`} testId="project-setup-requirements">
            {(readiness?.to_do ?? []).map((req) => row(req))}
          </Section>
        )}

        {!!readiness?.optional?.length && (
          <Section title={t`Optional`} testId="project-setup-optional">
            {readiness.optional.map((req) => row(req))}
          </Section>
        )}

        {!!readiness?.skipped?.length && (
          <Section title={t`Skipped on this machine`} testId="project-setup-skipped">
            {readiness.skipped.map((req) => row(req, true))}
          </Section>
        )}

        {!!readiness?.gaps?.length && (
          <ul className="flex flex-col gap-1">
            {readiness.gaps.map((gap) => (
              <li
                key={`gap-${gap.name}`}
                className="flex items-center gap-2 px-3 py-1 text-xs text-amber-700 dark:text-amber-400"
                data-testid={`project-setup-gap-${gap.name}`}
              >
                <AlertTriangle className="size-3.5 shrink-0" />
                {gap.note}
              </li>
            ))}
          </ul>
        )}

        {!readiness?.ready && !running && (
          <div>
            <Button data-testid="project-setup-start" disabled={!readiness} onClick={() => void start()}>
              {setup.tree ? t`Continue` : t`Start`}
            </Button>
          </div>
        )}

        {running && (
          <div className="border-t pt-3" data-testid="project-setup-running">
            {questionId ? (
              <AskForm questionId={questionId} showOp={false} onSettled={setup.settleQuestion} />
            ) : (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                <Trans>Working…</Trans>
              </p>
            )}
          </div>
        )}

        {setup.tree && (
          <div className="border-t pt-3" data-testid="project-setup-steps">
            <SetupTreeView tree={setup.tree} hideRoot />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <ul className="flex flex-col gap-1" data-testid={testId}>
        {children}
      </ul>
    </section>
  );
}

/** Keeps a button's click to itself: the row around it is a link. */
const own = (handler: () => void) => (event: MouseEvent) => {
  event.stopPropagation();
  handler();
};

/**
 * One requirement: the whole row opens its page (role=link, Enter too); Skip opens the inline choice —
 * Locally (a mark on its record, here) | Always (removed from the project, staged in git) | Cancel; a skipped row
 * says what will not work and offers Undo.
 */
function RequirementRow({
  req,
  skipped = false,
  running,
  busy,
  choosing = false,
  onChoose,
  onSkip,
  onUndo,
  onOpen,
}: {
  req: ProjectSetupRequirement;
  skipped?: boolean;
  running: boolean;
  busy: boolean;
  choosing?: boolean;
  onChoose?: (on: boolean) => void;
  onSkip?: (scope: ProjectSetupSkipScope) => void;
  onUndo?: () => void;
  onOpen: () => void;
}) {
  const { t } = useLingui();
  const Icon = iconOf(req);
  const name = namesItself(req) ? req.name : req.title || req.name;
  const keyOpen = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && event.target === event.currentTarget) onOpen();
  };
  return (
    <li
      role="link"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={keyOpen}
      className={cn(
        'flex cursor-pointer flex-col gap-1 rounded border px-3 py-2 text-sm hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary',
        skipped && 'opacity-70',
      )}
      data-testid={`project-setup-req-${req.name}`}
      data-typeid={req.typeid}
    >
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">{name}</span>
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <span className="truncate text-xs text-muted-foreground" title={[req.title, req.note].filter(Boolean).join(' — ')}>
            {skipped
              ? req.required
                ? t`required — it will not work here until it is set up`
                : t`optional — skipped here`
              : detailOf(req)}
          </span>
          {!skipped && <JustificationInfo req={req} />}
        </div>
        {busy && <Loader2 className="size-3 animate-spin" />}
        {!running && !busy && skipped && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            data-testid={`project-setup-undo-${req.name}`}
            onClick={own(() => onUndo?.())}
          >
            <Undo2 className="size-3" />
            <Trans>Undo</Trans>
          </Button>
        )}
        {!running && !busy && !skipped && !choosing && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            data-testid={`project-setup-skip-${req.name}`}
            onClick={own(() => onChoose?.(true))}
          >
            <Trans>Skip</Trans>
          </Button>
        )}
      </div>
      {choosing && !busy && (
        <div className="flex items-center gap-2 ps-6 text-xs" data-testid={`project-setup-skip-choice-${req.name}`}>
          <span className="text-muted-foreground">
            <Trans>Skip it…</Trans>
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            data-testid={`project-setup-skip-local-${req.name}`}
            title={t`On this machine only — undo any time`}
            onClick={own(() => onSkip?.('local'))}
          >
            <Trans>Locally</Trans>
          </Button>
          <span title={req.can_skip_always ? undefined : req.why_not_always}>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              data-testid={`project-setup-skip-always-${req.name}`}
              disabled={!req.can_skip_always}
              title={req.can_skip_always ? t`Remove it from the project — the deletion is staged in git` : undefined}
              onClick={own(() => onSkip?.('always'))}
            >
              <Trans>Always</Trans>
            </Button>
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            data-testid={`project-setup-skip-cancel-${req.name}`}
            onClick={own(() => onChoose?.(false))}
          >
            <Trans>Cancel</Trans>
          </Button>
          {!req.can_skip_always && req.why_not_always && (
            <span className="truncate text-muted-foreground" data-testid={`project-setup-why-not-always-${req.name}`}>
              {req.why_not_always}
            </span>
          )}
        </div>
      )}
    </li>
  );
}
