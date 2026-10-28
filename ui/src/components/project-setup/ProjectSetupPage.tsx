import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Project,
  recheckProjectReadiness,
  type ProjectReadiness,
  type ProjectSetupRequirement,
  type SetupNodeResult,
  type SetupTreeResult,
} from '@sdk';
import { ArrowLeft, Check, Loader2, Pencil, Play, RotateCw, Square, Undo2, type LucideIcon } from 'lucide-react';
import { AskForm } from '@src/components/ask/AskForm';
import { CredentialDialog } from '@src/components/credentials/CredentialDialog';
import { editDraft } from '@src/components/credentials/credential-draft';
import { useCredentials } from '@src/components/credentials/use-credentials';
import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { detailOf, iconOf, namesItself, pointerForRequirement, rowKey } from './ProjectSetupDialog';
import { countDrawn } from './SetupTreeView';
import { useSetupRun } from './use-setup-run';

/**
 * The project's setup as a page (Project Home ☰ → Project setup): every step with how it stands here, Edit and
 * Run on each, and Rerun for the whole tree. The runs are the same backend runs the setup dialog starts
 * (`useSetupRun`); a step's Run is that run rooted at the step's own node (`req.node`). Questions a run asks are
 * drawn in place, under the page header.
 */

type Status = 'todo' | 'optional' | 'ready' | 'skipped';

const TONE = {
  muted: 'text-muted-foreground',
  warn: 'border-yellow-500/60 bg-yellow-500/15 text-yellow-600 dark:text-yellow-400',
  ok: 'border-green-500/50 bg-green-500/15 text-green-600 dark:text-green-400',
  bad: 'border-red-500/50 bg-red-500/15 text-red-600 dark:text-red-400',
} as const;

/** A status pill: tone, an optional glyph, the words. */
function Chip({
  tone,
  icon: Icon,
  spin = false,
  testId,
  children,
}: {
  tone: keyof typeof TONE;
  icon?: LucideIcon;
  spin?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full border px-2 text-xs', TONE[tone])}
      data-testid={testId}
    >
      {Icon && <Icon className={cn('size-3', spin && 'animate-spin')} />}
      {children}
    </span>
  );
}

/** Which readiness list a row comes from — the order the page lists them in. */
const LISTS = [
  ['to_do', 'todo'],
  ['optional', 'optional'],
  ['set_up', 'ready'],
  ['skipped', 'skipped'],
] as const;

/** Every node of the tree by id (its first occurrence) — a row finds its live state here while a run goes. */
function nodesById(tree: SetupTreeResult | null): Map<string, SetupNodeResult> {
  const out = new Map<string, SetupNodeResult>();
  const walk = (node: SetupNodeResult | null | undefined) => {
    if (!node) return;
    // A node reached again under another parent (a credential an app needs) is the same step:
    // the first place it sits is where it runs.
    if (!out.has(node.id)) out.set(node.id, node);
    node.children.forEach(walk);
  };
  walk(tree?.root);
  return out;
}

export function ProjectSetupPage({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { t, i18n } = useLingui();
  const { navigation } = useDockNavigation();
  const [readiness, setReadiness] = useState<ProjectReadiness | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The credential being edited; its form (and the credentials it reads) mounts only then.
  const [editing, setEditing] = useState<ProjectSetupRequirement | null>(null);

  const load = useCallback(async () => {
    try {
      setReadiness(await Project.setupRequirements(projectId, { includeReady: true }));
    } catch (e) {
      notify.error({ title: errorMessage(e, t`Could not read the project's setup`) });
    }
  }, [projectId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const settled = useCallback(async () => {
    await Promise.all([load(), recheckProjectReadiness()]);
  }, [load]);

  const whole = useSetupRun(projectId, '', settled);
  const [stepRoot, setStepRoot] = useState('');
  const step = useSetupRun(projectId, stepRoot, settled);
  // One run is on screen at a time: the whole tree's, else the one step's.
  const run = whole.running || whole.starting || !stepRoot ? whole : step;
  const running = whole.running || step.running;

  // A step's Run sets its root; the run starts once its hook is rooted there.
  const [pendingStep, setPendingStep] = useState(false);
  useEffect(() => {
    if (!pendingStep || !stepRoot) return;
    setPendingStep(false);
    step.start().catch((e) => notify.error({ title: errorMessage(e, t`Could not start the setup`) }));
  }, [pendingStep, stepRoot, step, t]);

  const rerun = async () => {
    try {
      await whole.start();
    } catch (e) {
      notify.error({ title: errorMessage(e, t`Could not start the setup`) });
    }
  };

  const stop = async () => {
    try {
      await run.stop?.();
    } catch (e) {
      notify.error({ title: errorMessage(e, t`Could not stop the setup`) });
    }
  };

  const runStep = (req: ProjectSetupRequirement) => {
    if (!req.node) return;
    setStepRoot(req.node);
    setPendingStep(true);
  };

  const unskip = async (req: ProjectSetupRequirement) => {
    setBusy(rowKey(req));
    try {
      await Project.unskipSetup(projectId, req.typeid, req.name);
      await settled();
    } catch (e) {
      notify.error({ title: errorMessage(e, t`Could not undo the skip of ${req.name}`) });
    } finally {
      setBusy(null);
    }
  };

  // Edit: a credential opens its own form here; anything else opens its own page (URL-first).
  const edit = (req: ProjectSetupRequirement) => {
    if (req.kind === 'pack') {
      setEditing(req);
      return;
    }
    const pointer = pointerForRequirement(req, projectId);
    if (pointer) navigation.openDock(pointer);
  };

  const rows = useMemo(() => {
    // A row is listed once, under the first list that has it.
    const byKey = new Map<string, [ProjectSetupRequirement, Status]>();
    for (const [list, status] of LISTS)
      for (const req of readiness?.[list] ?? []) if (!byKey.has(rowKey(req))) byKey.set(rowKey(req), [req, status]);
    return [...byKey.values()];
  }, [readiness]);

  const live = useMemo(() => nodesById(running ? run.tree : null), [running, run.tree]);
  const left = readiness?.ready ? 0 : (readiness?.to_do.length ?? 0);
  const drawn = countDrawn(run.tree?.root?.children ?? []);
  const lastRun = whole.tree?.finished_at ? new Date(whole.tree.finished_at) : null;
  const lastRunState =
    (
      { done: t`passed`, stopped: t`stopped`, failed: t`did not finish`, blocked: t`did not finish` } as Record<
        string,
        string
      >
    )[whole.tree?.state ?? ''] ??
    whole.tree?.state ??
    '';

  return (
    <div className="flex flex-col gap-6" data-testid="project-setup-page">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-fit gap-1 px-2 text-xs text-muted-foreground"
        data-testid="project-setup-back"
        onClick={() => navigation.openDock(DockPointer.forProject(projectId))}
      >
        <ArrowLeft className="size-3 rtl:-scale-x-100" />
        <Trans>Project home</Trans>
      </Button>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold leading-none tracking-tight">
              <Trans>Project setup</Trans>
            </h2>
            {running ? (
              <Chip tone="muted" icon={Loader2} spin testId="project-setup-page-chip">
                {drawn.total ? t`Running ${drawn.done} of ${drawn.total}` : t`Running`}
              </Chip>
            ) : readiness && left > 0 ? (
              <Chip tone="warn" testId="project-setup-page-chip">
                <Trans>{left} left</Trans>
              </Chip>
            ) : readiness ? (
              <Chip tone="ok" testId="project-setup-page-chip">
                <Trans>Ready</Trans>
              </Chip>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {running ? (
              <Trans>Running the setup. Steps that pass stay green; you are asked only for what is missing.</Trans>
            ) : (
              <Trans>What {projectName} needs to run on this computer, and whether each step passed.</Trans>
            )}
          </p>
          {lastRun && !running && (
            <p className="text-xs text-muted-foreground" data-testid="project-setup-last-run">
              <Trans>
                Last run {i18n.date(lastRun, { dateStyle: 'medium', timeStyle: 'short' })} · {lastRunState}
              </Trans>
            </p>
          )}
        </div>
        <div className="flex-1" />
        {running ? (
          run.stop && (
            <Button variant="outline" data-testid="project-setup-page-stop" onClick={() => void stop()}>
              <Square className="size-3" />
              <Trans>Stop</Trans>
            </Button>
          )
        ) : (
          <Button
            data-testid="project-setup-rerun"
            disabled={!readiness || whole.starting}
            onClick={() => void rerun()}
          >
            {whole.starting ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
            {whole.tree ? <Trans>Rerun setup</Trans> : <Trans>Run setup</Trans>}
          </Button>
        )}
      </div>

      {running && run.questionId && (
        <div className="rounded border p-3" data-testid="project-setup-page-question">
          <AskForm questionId={run.questionId} showOp={false} onSettled={run.settleQuestion} />
        </div>
      )}

      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Trans>Steps</Trans>
        </h3>
        {!readiness ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <Trans>Reading the setup…</Trans>
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="project-setup-page-empty">
            <Trans>This project declares no setup steps.</Trans>
          </p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="project-setup-page-steps">
            {rows.map(([req, status]) => (
              <StepRow
                key={rowKey(req)}
                req={req}
                status={status}
                node={req.node ? live.get(req.node) : undefined}
                running={running}
                busy={busy === rowKey(req)}
                onEdit={() => edit(req)}
                onRun={req.node ? () => runStep(req) : undefined}
                onUndo={() => void unskip(req)}
              />
            ))}
          </ul>
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        <Trans>Setup is saved with the project, so everyone who opens {projectName} runs the same steps.</Trans>
      </p>

      {editing && (
        <EditCredential
          req={editing}
          projectId={projectId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void settled();
          }}
        />
      )}
    </div>
  );
}

/** A credential step's own form, over the credentials it reads (fetched only while it is open). */
function EditCredential({
  req,
  projectId,
  onClose,
  onSaved,
}: {
  req: ProjectSetupRequirement;
  projectId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLingui();
  const { status, ready, refresh } = useCredentials(projectId);
  const row = status.credentials.find((c) => c.typeid === req.typeid);
  const draft = useMemo(() => (row ? editDraft(row) : null), [row]);
  if (!ready || !draft) return null;
  return (
    <CredentialDialog
      draft={draft}
      projectId={projectId}
      status={status}
      onRefresh={refresh}
      onClose={onClose}
      onSaved={async (saved) => {
        await refresh();
        notify.success({ title: t`${saved.title} saved` });
        onSaved();
      }}
    />
  );
}

function StepRow({
  req,
  status,
  node,
  running,
  busy,
  onEdit,
  onRun,
  onUndo,
}: {
  req: ProjectSetupRequirement;
  status: Status;
  node?: SetupNodeResult;
  running: boolean;
  busy: boolean;
  onEdit: () => void;
  onRun?: () => void;
  onUndo: () => void;
}) {
  const { t } = useLingui();
  const Icon = iconOf(req);
  const rowId = req.kind === 'pack' ? req.name : `${req.kind}-${req.name}`;
  const usedBy = req.used_by.join(', ');
  const kindLabel =
    req.kind === 'pack'
      ? req.credential_kind === 'oauth'
        ? t`Connection`
        : t`Credential`
      : (({ source: t`Data source`, webapp: t`Web app` } as Record<string, string>)[req.kind] ?? t`Dependency`);

  // While a run goes, the step says what the run says of it; otherwise how it stands here.
  const live = running ? node?.state : undefined;
  const chip =
    live === 'running' ? (
      <Chip tone="muted" icon={Loader2} spin>
        <Trans>Running</Trans>
      </Chip>
    ) : live === 'done' ? (
      <Chip tone="ok" icon={Check}>
        <Trans>Passed</Trans>
      </Chip>
    ) : live === 'failed' || live === 'refused' ? (
      <Chip tone="bad">
        <Trans>Failed</Trans>
      </Chip>
    ) : status === 'todo' ? (
      <Chip tone="warn">
        <Trans>Needs setup</Trans>
      </Chip>
    ) : status === 'optional' ? (
      <Chip tone="muted">
        <Trans>Optional · not set up</Trans>
      </Chip>
    ) : status === 'skipped' ? (
      <Chip tone="muted">
        <Trans>Skipped on this machine</Trans>
      </Chip>
    ) : (
      <Chip tone="ok">
        <Trans>Ready</Trans>
      </Chip>
    );

  const detail = node && running && node.detail ? node.detail : status === 'ready' ? '' : detailOf(req, t` or `);

  return (
    <li
      className={cn('flex flex-col gap-1 rounded border px-3 py-2 text-sm', status === 'skipped' && 'opacity-70')}
      data-testid={`project-setup-step-${rowId}`}
      data-status={status}
    >
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">{namesItself(req) ? req.name : req.title || req.name}</span>
        <Chip tone="muted">{kindLabel}</Chip>
        <span data-testid={`project-setup-step-state-${rowId}`}>{chip}</span>
        <div className="flex-1" />
        {busy && <Loader2 className="size-3 animate-spin" />}
        {!running && !busy && status === 'skipped' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            data-testid={`project-setup-step-undo-${rowId}`}
            onClick={onUndo}
          >
            <Undo2 className="size-3" />
            <Trans>Undo skip</Trans>
          </Button>
        )}
        {status !== 'skipped' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            data-testid={`project-setup-step-edit-${rowId}`}
            onClick={onEdit}
          >
            <Pencil className="size-3" />
            <Trans>Edit</Trans>
          </Button>
        )}
        {status !== 'skipped' && onRun && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            disabled={running}
            data-testid={`project-setup-step-run-${rowId}`}
            onClick={onRun}
          >
            <Play className="size-3" />
            <Trans>Run</Trans>
          </Button>
        )}
      </div>
      {!!detail && <div className="ps-6 text-xs text-muted-foreground">{detail}</div>}
      {!!usedBy && (
        <div className="ps-6 text-xs text-muted-foreground">
          <Trans>Used by: {usedBy}</Trans>
        </div>
      )}
    </li>
  );
}
