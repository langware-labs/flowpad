import { useLingui } from '@lingui/react/macro';
import type { LucideIcon } from 'lucide-react';
import { AgenticProcess } from '@sdk';
import { cn } from '@src/lib/utils';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { IconWithBadge } from '@src/components/graph-view/icons/IconWithBadge';
import { subIconForEntity } from '@src/components/graph-view/icons/subIconRegistry';
import { useIsAdvanced } from '@src/contexts/view-mode-context';
import { useContextProcess } from '@src/hooks/useContextProcess';

/** Per-state wording (label + tooltip) for the button. */
interface ContextProcessCopy {
  /** Override the icon (defaults to the AgenticProcess type icon). */
  icon?: LucideIcon;
  /** Wording when no process is bound yet (the launch action). */
  launch: { label: string; tooltip: string };
  /** Wording when a bound process exists (the resume action). */
  resume: { label: string; tooltip: string };
}

/**
 * Generic per-surface "context process" control (advanced mode only). Declares a
 * context (a set of entity typeids keyed by a stable `target`) and, on click,
 * RESUMES the last process bound to it or LAUNCHES a new one — via
 * {@link useContextProcess}. Each surface (per-message, per-analysis, diagnose, …)
 * just computes its own `target` + `contextTypeids` and renders this.
 *
 * `copy` lets a surface override the icon/labels/tooltips; it defaults to the
 * generic, readable "Context process" / "Resume context" wording (and the
 * AgenticProcess type icon) so every site reads the same unless it has reason to.
 */
export function ContextProcessButton({
  target,
  contextTypeids,
  projectId,
  name,
  className,
  copy,
}: {
  /** Reuse key (`target_typeid_str`) — the identity entity of this context. */
  target: string | null;
  /** The full context: typeids folded into the worker's summary. */
  contextTypeids: string[];
  projectId?: string | null;
  /** GraphContext display name. */
  name?: string;
  /** Surface-specific spacing (e.g. `mt-1.5` for a footer row). */
  className?: string;
  /** Per-surface wording; falls back to the generic copy. */
  copy?: ContextProcessCopy;
}) {
  const { t } = useLingui();
  const isAdvanced = useIsAdvanced();
  const { existing, busy, openOrLaunch } = useContextProcess({
    target,
    contextTypeids,
    projectId,
    name,
    enabled: isAdvanced, // don't run the resume lookup unless the control is shown
  });

  if (!isAdvanced || !target) return null;

  const c: ContextProcessCopy = copy ?? {
    launch: { label: t`Context process`, tooltip: t`Start a context process for this` },
    resume: { label: t`Resume context`, tooltip: t`Resume the context process` },
  };
  const state = existing ? c.resume : c.launch;

  // A per-surface `copy.icon` override wins as-is. Otherwise the AgenticProcess
  // type glyph, badged with the bound process's worker-type sub-icon (base-only
  // until a process binds — worker_type is unknown before then).
  const Base = c.icon ?? iconForType(AgenticProcess.type);
  const Sub = c.icon ? null : subIconForEntity(existing);

  return (
    <button
      type="button"
      onClick={openOrLaunch}
      disabled={busy}
      title={state.tooltip}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50',
        className,
      )}
    >
      <IconWithBadge Base={Base} Badge={Sub} className="h-3 w-3" />
      {state.label}
    </button>
  );
}
