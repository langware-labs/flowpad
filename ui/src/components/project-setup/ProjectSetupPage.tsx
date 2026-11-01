import { useMemo, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { ProjectSetupRequirement, SetupNodeResult, SetupTreeResult } from '@sdk';
import { ArrowLeft, Loader2, Pencil, Play, RotateCw, Square, Undo2, type LucideIcon } from 'lucide-react';
import { AskForm } from '@src/components/ask/AskForm';
import { CredentialDialog } from '@src/components/credentials/CredentialDialog';
import { editDraft } from '@src/components/credentials/credential-draft';
import { useCredentials } from '@src/components/credentials/use-credentials';
import { Badge, type BadgeProps } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { detailOf, iconOf, namesItself, pointerForRequirement } from './ProjectSetupDialog';
import { rowId, rowKey, stepKind } from './setup-labels';
import { countDrawn, stateGlyph } from './SetupTreeView';
import { useSetupReadiness, withNotify } from './use-setup-readiness';
import { useSetupRun } from './use-setup-run';

/**
 * The project's setup as a page (Project Home ☰ → Project setup): every step with how it stands here, Edit and
 * Run on each, and Rerun for the whole tree. The run is the same backend run the setup dialog starts
 * (`useSetupRun`); a step's Run is that run rooted at the step's own node (`req.node`). Questions a run asks are
 * drawn in place, under the page header.
 */

type Status = 'todo' | 'optional' | 'ready' | 'skipped';

/** Which readiness list a row comes from — the order the page lists them in. */
const LISTS = [
  ['to_do', 'todo'],
  ['optional', 'optional'],
  ['set_up', 'ready'],
  ['skipped', 'skipped'],
] as const;

type Variant = NonNullable<BadgeProps['variant']>;
interface ChipSpec {
  variant: Variant;
  label: MessageDescriptor;
}

/** How a step stands here, when no run says otherwise. */
const STATUS_CHIP: Record<Status, ChipSpec> = {
  todo: { variant: 'warning', label: msg`Needs setup` },
  optional: { variant: 'muted', label: msg`Optional · not set up` },
  ready: { variant: 'success', label: msg`Ready` },
  skipped: { variant: 'muted', label: msg`Skipped on this machine` },
};

/** What a run says of a step, for the states worth saying while it goes. */
const LIVE_CHIP: Partial<Record<SetupNodeResult['state'], ChipSpec>> = {
  running: { variant: 'muted', label: msg`Running` },
  done: { variant: 'success', label: msg`Passed` },
  failed: { variant: 'danger', label: msg`Failed` },
  refused: { variant: 'danger', label: msg`Failed` },
};

/** How the last run ended, in words. */
const LAST_RUN: Partial<Record<SetupTreeResult['state'], MessageDescriptor>> = {
  done: msg`passed`,
  stopped: msg`stopped`,
  failed: msg`did not finish`,
  blocked: msg`did not finish`,
};

/** A status pill: the shared Badge in a tone, an optional glyph, the words. */
function Chip({
  variant,
  icon: Icon,
  spin = false,
  testId,
  children,
}: {
  variant: Variant;
  icon?: LucideIcon;
  spin?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <Badge variant={variant} className="gap-1 rounded-full px-2 py-0 font-normal" data-testid={testId}>
      {Icon && <Icon className={cn('size-3', spin && 'animate-spin')} />}
      {children}
    </Badge>
  );
}

/** A row's small action button. */
function StepAction({
  icon: Icon,
  testId,
  disabled,
  onClick,
  children,
}: {
  icon: LucideIcon;
  testId: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 gap-1 px-2 text-xs"
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
    >
      <Icon className="size-3" />
      {children}
    </Button>
  );
}

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
  const { readiness, busy, load, unskip } = useSetupReadiness(projectId, { includeReady: true });
  const run = useSetupRun(projectId, '', load);
  // The credential being edited; its form (and the credentials it reads) mounts only then.
  const [editing, setEditing] = useState<ProjectSetupRequirement | null>(null);

  const startAt = (root = '') => void withNotify(() => run.start(root), t`Could not start the setup`);
  const stop = () => void withNotify(async () => run.stop?.(), t`Could not stop the setup`);

  // Edit: a credential opens its own form here; anything else opens its own page (URL-first).
  const edit = (req: ProjectSetupRequirement) => {
    if (req.kind === 'pack') return setEditing(req);
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

  const running = run.running;
  const live = useMemo(() => nodesById(running ? run.tree : null), [running, run.tree]);
  const left = readiness?.ready ? 0 : (readiness?.to_do.length ?? 0);
  const drawn = countDrawn(run.tree?.root?.children ?? []);
  // The last run is the whole tree's: a step's own run says nothing about the others.
  const whole = run.root === '' ? run.tree : null;
  const lastRun = whole?.finished_at ? new Date(whole.finished_at) : null;
  const lastRunWords = whole ? LAST_RUN[whole.state] : undefined;
  const lastRunState = lastRunWords ? i18n._(lastRunWords) : (whole?.state ?? '');

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
              <Chip variant="muted" icon={Loader2} spin testId="project-setup-page-chip">
                {drawn.total ? t`Running ${drawn.done} of ${drawn.total}` : t`Running`}
              </Chip>
            ) : readiness ? (
              <Chip variant={left > 0 ? 'warning' : 'success'} testId="project-setup-page-chip">
                {left > 0 ? t`${left} left` : t`Ready`}
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
            <Button variant="outline" data-testid="project-setup-page-stop" onClick={stop}>
              <Square className="size-3" />
              <Trans>Stop</Trans>
            </Button>
          )
        ) : (
          <Button data-testid="project-setup-rerun" disabled={!readiness || run.starting} onClick={() => startAt()}>
            {run.starting ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
            {whole ? <Trans>Rerun setup</Trans> : <Trans>Run setup</Trans>}
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
                node={running && req.node ? live.get(req.node) : undefined}
                running={running}
                busy={busy.has(rowKey(req))}
                onEdit={() => edit(req)}
                onRun={req.node ? () => startAt(req.node) : undefined}
                onUndo={() => void unskip(req, t`Could not undo the skip of ${req.name}`)}
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
            void load();
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
  /** The step's node in the run going now — absent when nothing runs. */
  node?: SetupNodeResult;
  running: boolean;
  busy: boolean;
  onEdit: () => void;
  onRun?: () => void;
  onUndo: () => void;
}) {
  const { t, i18n } = useLingui();
  const Icon = iconOf(req);
  const id = rowId(req);
  const usedBy = req.used_by.join(', ');
  // While a run goes, the step says what the run says of it; otherwise how it stands here.
  const liveChip = node && LIVE_CHIP[node.state];
  const glyph = node ? stateGlyph(node.state) : null;
  const detail = node?.detail || (status === 'ready' ? '' : detailOf(req, t` or `));

  return (
    <li
      className={cn('flex flex-col gap-1 rounded border px-3 py-2 text-sm', status === 'skipped' && 'opacity-70')}
      data-testid={`project-setup-step-${id}`}
      data-status={status}
    >
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">{namesItself(req) ? req.name : req.title || req.name}</span>
        <Chip variant="muted">{i18n._(stepKind(req))}</Chip>
        <span data-testid={`project-setup-step-state-${id}`}>
          {liveChip && glyph ? (
            <Chip variant={liveChip.variant} icon={glyph.Icon} spin={glyph.spin}>
              {i18n._(liveChip.label)}
            </Chip>
          ) : (
            <Chip variant={STATUS_CHIP[status].variant}>{i18n._(STATUS_CHIP[status].label)}</Chip>
          )}
        </span>
        <div className="flex-1" />
        {busy && <Loader2 className="size-3 animate-spin" />}
        {status === 'skipped' ? (
          !running &&
          !busy && (
            <StepAction icon={Undo2} testId={`project-setup-step-undo-${id}`} onClick={onUndo}>
              <Trans>Undo skip</Trans>
            </StepAction>
          )
        ) : (
          <>
            <StepAction icon={Pencil} testId={`project-setup-step-edit-${id}`} onClick={onEdit}>
              <Trans>Edit</Trans>
            </StepAction>
            {onRun && (
              <StepAction icon={Play} testId={`project-setup-step-run-${id}`} disabled={running} onClick={onRun}>
                <Trans>Run</Trans>
              </StepAction>
            )}
          </>
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
