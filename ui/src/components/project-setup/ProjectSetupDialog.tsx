import { useCallback, useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  CredentialRequirement,
  CredentialsSubview,
  Layout,
  missingNeeds,
  Project,
  recheckProjectReadiness,
  requirementOf,
  setProjectReadiness,
  TypeId,
  type ProjectReadiness,
  type ProjectSetupRequirement,
  type ProjectSetupSkipScope,
  type SetupNodeResult,
  type SetupTreeResult,
} from '@sdk';
import { AlertTriangle, CheckCircle2, Info, Loader2, Package, Square, Undo2, type LucideIcon } from 'lucide-react';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { AskForm } from '@src/components/ask/AskForm';
import { useOptionalFloatingChat } from '@src/components/floating-chat/floating-chat-context';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { useProjectSetupStore } from './project-setup-store';
import { countDrawn, SetupTreeView } from './SetupTreeView';
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

const NONE: ReadonlySet<string> = new Set();

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
const namesItself = (req: ProjectSetupRequirement) =>
  req.kind === 'dependency' || req.kind === 'source' || req.kind === 'webapp';

/**
 * What a row says beside its name: why it is not ready, else what the credential is needed for, else what is
 * missing — an either-or group of values as "A or B".
 */
function detailOf(req: ProjectSetupRequirement, or: string): string {
  if (namesItself(req)) return req.note || req.title;
  if (req.credential_kind === 'oauth') return req.note || req.needed_for || `connect ${req.title || req.name}`;
  return (
    req.needed_for ||
    [
      ...missingNeeds(req.vars),
      // What is listed but not needed (an optional value) stays listed, as before.
      ...req.vars.filter((v) => !v.present && requirementOf(v) === CredentialRequirement.OPTIONAL).map((v) => [v]),
    ]
      .map((need) => need.map((v) => v.label || v.env_var).join(or))
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
  return (
    <ProjectSetupDialog
      projectId={payload.projectId}
      projectName={payload.projectName}
      open={open}
      onOpenChange={setOpen}
    />
  );
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
  const [busy, setBusy] = useState(NONE);
  const [selected, setSelected] = useState(NONE);
  const { navigation } = useDockNavigation();
  const assistant = useOptionalFloatingChat();

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

  const stop = async () => {
    try {
      await setup.stop?.();
    } catch (e) {
      notify.error({ title: errorMessage(e, t`Could not stop the setup`) });
    }
  };

  /** The skip answers with the readiness that follows: the dialog and the footer take it as is. */
  const settle = (next: ProjectReadiness | null) => {
    setReadiness(next);
    if (next) setProjectReadiness(next);
  };

  /** Skips each of ``reqs``, one after the other (each answer is the readiness that follows), then selects none. */
  const skip = async (reqs: ProjectSetupRequirement[], scope: ProjectSetupSkipScope) => {
    setBusy(new Set(reqs.map(rowKey)));
    for (const req of reqs) {
      try {
        settle(await Project.skipSetup(projectId, req.typeid, scope, { name: req.name }));
      } catch (e) {
        notify.error({ title: errorMessage(e, t`Could not skip ${req.name}`) });
      }
    }
    setSelected(NONE);
    setBusy(NONE);
  };

  const select = (req: ProjectSetupRequirement, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(rowKey(req));
    else next.delete(rowKey(req));
    setSelected(next);
  };

  const unskip = async (req: ProjectSetupRequirement) => {
    setBusy(new Set([rowKey(req)]));
    try {
      settle(await Project.unskipSetup(projectId, req.typeid, req.name));
    } catch (e) {
      notify.error({ title: errorMessage(e, t`Could not undo the skip of ${req.name}`) });
    } finally {
      setBusy(NONE);
    }
  };

  // URL-first: a row's click only navigates; the page it opens selects the entry from the URL.
  const openRow = (req: ProjectSetupRequirement) => {
    const pointer = pointerForRequirement(req, projectId);
    if (!pointer) return;
    onOpenChange(false);
    navigation.openDock(pointer);
  };

  /** Hands the row to the assistant's chat, which grows out of the button; the dialog closes so the chat is in reach. */
  const explain = (req: ProjectSetupRequirement, button: HTMLElement) => {
    const rect = button.getBoundingClientRect();
    onOpenChange(false);
    assistant?.ask(
      [
        `Explain briefly the setup requirement "${req.title || req.name}" of the project "${projectName}":`,
        'what it is, why the project needs it, and how I get it.',
        `It is a ${req.kind}${req.typeid ? ` (${req.typeid})` : ''}.`,
        req.needed_for && `Needed for: ${req.needed_for}`,
        req.justification && `Declared reason: ${req.justification}`,
        req.note && `Current state: ${req.note}`,
      ]
        .filter(Boolean)
        .join('\n'),
      { rect },
    );
  };

  const running = setup.running;
  const questionId = setup.questionId;

  // What can be selected is what can be skipped: a row still to do — a run going too (the run skips it live).
  const selectedReqs = [...(readiness?.to_do ?? []), ...(readiness?.optional ?? [])].filter((req) =>
    selected.has(rowKey(req)),
  );
  const selecting = selectedReqs.length > 0;

  const row = (req: ProjectSetupRequirement, skipped = false) => (
    <RequirementRow
      key={rowKey(req)}
      req={req}
      skipped={skipped}
      running={running}
      busy={busy.has(rowKey(req))}
      selected={selected.has(rowKey(req))}
      onSelect={skipped ? undefined : (on) => select(req, on)}
      onSkip={selecting ? undefined : () => setSelected(new Set([rowKey(req)]))}
      onUndo={() => void unskip(req)}
      onOpen={() => openRow(req)}
      onExplain={assistant ? (button) => explain(req, button) : undefined}
    />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto" data-testid="project-setup-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Project requirements</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Needed to run {projectName} on this computer.</Trans>
          </DialogDescription>
        </DialogHeader>

        {selecting && (
          <div
            className="flex items-center gap-2 rounded border bg-muted/50 px-3 py-1.5 text-xs"
            data-testid="project-setup-selection-bar"
          >
            <span className="flex-1 font-medium">
              <Trans>{selectedReqs.length} selected</Trans>
            </span>
            {busy.size > 0 && <Loader2 className="size-3 animate-spin" />}
            <SkipChoice
              id="selected"
              disabled={busy.size > 0}
              whyNotAlways={
                selectedReqs.every((req) => req.can_skip_always)
                  ? ''
                  : t`Some of the selected cannot be removed from the project`
              }
              onSkip={(scope) => void skip(selectedReqs, scope)}
              onCancel={() => setSelected(NONE)}
            />
          </div>
        )}

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

        <SetupStatusLine
          tree={setup.tree}
          running={running}
          canStart={!!readiness && !readiness.ready}
          onStart={() => void start()}
          onStop={setup.stop && (() => void stop())}
        />

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

        {/* The steps are for watching a run; while a question is open the question is the screen. */}
        {setup.tree && !questionId && (
          <div className="border-t pt-3" data-testid="project-setup-steps">
            <SetupTreeView tree={setup.tree} hideRoot />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The node the run is on: the deepest one running. */
function currentNode(node: SetupNodeResult | null | undefined): SetupNodeResult | null {
  if (!node || node.state !== 'running') return null;
  for (const child of node.children) {
    const deeper = currentNode(child);
    if (deeper) return deeper;
  }
  return node;
}

/** How many nodes under ``node`` did not finish (a shared node counts where it was set up). */
function unfinishedUnder(node: SetupNodeResult): number {
  return node.children.reduce(
    (n, c) => n + (c.shared ? 0 : (c.state === 'failed' || c.state === 'blocked' ? 1 : 0) + unfinishedUnder(c)),
    0,
  );
}

/**
 * The run in one line, with its one control: running — what it is on, n of m, Stop; not running — how the last
 * run ended (stopped / failed), and Start, Continue or Retry.
 */
function SetupStatusLine({
  tree,
  running,
  canStart,
  onStart,
  onStop,
}: {
  tree: SetupTreeResult | null;
  running: boolean;
  canStart: boolean;
  onStart: () => void;
  onStop?: () => void;
}) {
  const { t } = useLingui();
  if (running) {
    const now = currentNode(tree?.root);
    // The same count as the list below it, which draws the tree without its root.
    const drawn = countDrawn(tree?.root?.children ?? []);
    return (
      <div className="flex items-center gap-2 text-sm" data-testid="project-setup-status">
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          {now && now.id !== tree?.root?.id ? t`Setting up ${now.label}` : t`Setting up…`}
          {drawn.total ? <span className="text-muted-foreground">{` · ${drawn.done} / ${drawn.total}`}</span> : null}
        </span>
        {onStop && (
          <Button variant="outline" size="sm" className="h-7 gap-1" data-testid="project-setup-stop" onClick={onStop}>
            <Square className="size-3" />
            <Trans>Stop</Trans>
          </Button>
        )}
      </div>
    );
  }
  if (!canStart) return null;
  // How the last run ended decides both the words and the button.
  const failed = tree?.state === 'failed' || tree?.state === 'blocked';
  const unfinished = failed && tree?.root ? unfinishedUnder(tree.root) : 0;
  return (
    <div className="flex items-center gap-2 text-sm" data-testid="project-setup-status">
      {tree && (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {tree.state === 'stopped' ? t`Stopped` : failed ? t`${unfinished} did not finish` : null}
        </span>
      )}
      <Button data-testid="project-setup-start" onClick={onStart}>
        {!tree ? t`Start` : failed ? t`Retry` : t`Continue`}
      </Button>
    </div>
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
 * The selection bar's skip choice — Locally (a mark on its record, here) | Always (removed from the project, staged in git) |
 * Cancel — of every selected row. ``whyNotAlways`` set means Always is not offered, and why.
 */
function SkipChoice({
  id,
  disabled = false,
  whyNotAlways,
  onSkip,
  onCancel,
}: {
  id: string;
  disabled?: boolean;
  whyNotAlways: string;
  onSkip: (scope: ProjectSetupSkipScope) => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  return (
    <>
      <span className="text-muted-foreground">
        <Trans>Skip it…</Trans>
      </span>
      <Button
        variant="outline"
        size="sm"
        className="h-6 px-2 text-xs"
        data-testid={`project-setup-skip-local-${id}`}
        disabled={disabled}
        title={t`On this machine only — undo any time`}
        onClick={own(() => onSkip('local'))}
      >
        <Trans>Locally</Trans>
      </Button>
      <span title={whyNotAlways || undefined}>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          data-testid={`project-setup-skip-always-${id}`}
          disabled={disabled || !!whyNotAlways}
          title={whyNotAlways ? undefined : t`Remove it from the project — the deletion is staged in git`}
          onClick={own(() => onSkip('always'))}
        >
          <Trans>Always</Trans>
        </Button>
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        data-testid={`project-setup-skip-cancel-${id}`}
        disabled={disabled}
        onClick={own(onCancel)}
      >
        <Trans>Cancel</Trans>
      </Button>
    </>
  );
}

/**
 * One requirement: the whole row opens its page (role=link, Enter too); its checkbox selects it for the
 * selection bar, and while any row is selected no row offers its own Skip (no ``onSkip``). Skip selects just this
 * row, so it gets the same Locally | Always | Cancel bar as a multi-row selection; a skipped row says what will not work and offers Undo.
 */
function RequirementRow({
  req,
  skipped = false,
  running,
  busy,
  selected = false,
  onSelect,
  onSkip,
  onUndo,
  onOpen,
  onExplain,
}: {
  req: ProjectSetupRequirement;
  skipped?: boolean;
  running: boolean;
  busy: boolean;
  selected?: boolean;
  onSelect?: (on: boolean) => void;
  onSkip?: () => void;
  onUndo?: () => void;
  onOpen: () => void;
  onExplain?: (button: HTMLElement) => void;
}) {
  const { t } = useLingui();
  const Icon = iconOf(req);
  const name = namesItself(req) ? req.name : req.title || req.name;
  const usedBy = req.used_by.join(', ');
  // Unique per row: a credential and the data source using it can share a name.
  const rowId = req.kind === 'pack' ? req.name : `${req.kind}-${req.name}`;
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
      data-testid={`project-setup-req-${rowId}`}
      data-typeid={req.typeid}
    >
      <div className="flex items-center gap-2">
        {onSelect && (
          <Checkbox
            checked={selected}
            disabled={busy}
            aria-label={t`Select ${name}`}
            data-testid={`project-setup-select-${rowId}`}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onCheckedChange={(on) => onSelect(on === true)}
          />
        )}
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">{name}</span>
        {skipped ? (
          <span className="text-xs text-muted-foreground" data-testid={`project-setup-skipped-note-${rowId}`}>
            {req.required ? t`Required — skipped on this machine` : t`Optional — skipped on this machine`}
          </span>
        ) : (
          <span
            className="rounded-full border px-2 text-xs text-muted-foreground"
            data-testid={`project-setup-chip-${rowId}`}
          >
            {req.required ? t`Required` : t`Optional`}
          </span>
        )}
        <div className="flex-1" />
        {busy && <Loader2 className="size-3 animate-spin" />}
        {!busy && onExplain && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            data-testid={`project-setup-explain-${rowId}`}
            onClick={(event) => {
              event.stopPropagation();
              onExplain(event.currentTarget);
            }}
          >
            <Trans>Explain</Trans>
          </Button>
        )}
        {!running && !busy && skipped && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            data-testid={`project-setup-undo-${rowId}`}
            onClick={own(() => onUndo?.())}
          >
            <Undo2 className="size-3" />
            <Trans>Undo</Trans>
          </Button>
        )}
        {!busy && !skipped && onSkip && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            data-testid={`project-setup-skip-${rowId}`}
            onClick={own(onSkip)}
          >
            <Trans>Skip</Trans>
          </Button>
        )}
      </div>
      {/* The WHY, whole: one line a person reads to decide — never truncated. A skipped row says only that. */}
      {!skipped && (
        <div className="flex items-start gap-1 ps-6 text-xs text-muted-foreground">
          <span data-testid={`project-setup-detail-${rowId}`} title={req.note || undefined}>
            {detailOf(req, t` or `)}
          </span>
          <JustificationInfo req={req} />
        </div>
      )}
      {!skipped && !!usedBy && (
        <div className="ps-6 text-xs text-muted-foreground" data-testid={`project-setup-used-by-${rowId}`}>
          <Trans>Used by: {usedBy}</Trans>
        </div>
      )}
    </li>
  );
}
