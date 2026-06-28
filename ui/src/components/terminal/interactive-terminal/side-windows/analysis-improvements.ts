/** Pure derivations behind the Analysis side-window's per-skill Improve controls.
 * Kept React-free so they're exercisable in a no-mock unit test (the hook just
 * wires queries + git status into these). */
import type { AgentTraceDoc, TraceFinding } from '@src/components/assets/editor/agent-trace/trace-types';

export type ImproveStatus = 'idle' | 'running' | 'done';

export interface ImprovableSkill {
  skillName: string;
  findings: TraceFinding[];
}

/**
 * The skills an analysis attributed ≥1 finding to — the panel's improvable set,
 * read from `trace.json` `annotations.by_skill`. Skills with no findings are
 * dropped (nothing to improve).
 */
export function improvableSkills(doc: AgentTraceDoc | null): ImprovableSkill[] {
  const bySkill = doc?.annotations?.by_skill ?? {};
  return Object.values(bySkill)
    .filter((b) => (b.findings?.length ?? 0) > 0)
    .map((b) => ({ skillName: b.skill, findings: b.findings ?? [] }));
}

/**
 * Whether a skill's own SKILL.md has uncommitted changes. `git status` paths are
 * repo-root-relative and a repo holds many skills (each with a `SKILL.md`), so
 * match the last two segments (`<skill-dir>/SKILL.md`) — a bare basename match
 * would mark every skill dirty whenever any one of them is.
 */
export function skillFileIsDirty(statusFiles: { path: string }[], skillFilePath: string): boolean {
  const tail = skillFilePath.split('/').slice(-2).join('/');
  return statusFiles.some((f) => f.path.endsWith(tail));
}

/**
 * Per-skill Improve control state. Completion is read off the working tree:
 * improve is gated on a clean SKILL.md, so a dirty file means there's an
 * improvement to review (`done`). While a launched run is active it's
 * `running`; otherwise `idle` (offer Improve).
 */
export function deriveImproveStatus(args: {
  dirty: boolean;
  launched: boolean;
  anyRunning: boolean;
}): ImproveStatus {
  if (args.dirty) return 'done';
  if (args.launched && args.anyRunning) return 'running';
  return 'idle';
}

/** Hard cap on improvement cycles for one skill — a fresh analysis after each. */
export const MAX_IMPROVE_CYCLES = 3;

/**
 * Should the analyze→improve→version loop run another cycle? Stop when:
 *  - the cap is reached (`cycleCount >= MAX_IMPROVE_CYCLES`),
 *  - the prior cycle left an unsaved (dirty) improvement — commit/review it first, or
 *  - the latest analysis surfaced no improvable skills (nothing left to fix).
 * Pure: the loop driver (test or future feature) owns the I/O; this owns the decision.
 */
export function shouldRunAnotherCycle(args: {
  cycleCount: number;
  priorCycleDirty: boolean;
  analysisDoc: AgentTraceDoc | null;
}): boolean {
  if (args.cycleCount >= MAX_IMPROVE_CYCLES) return false;
  if (args.priorCycleDirty) return false;
  return improvableSkills(args.analysisDoc).length > 0;
}

// ── Value projection — the modal's "~$X/run reclaimable" headline ────────────
// Pure; the modal computes nothing. The figure is a PROJECTION (a measured
// delta would need a real post-version run — a later increment).

/** Conservative waste fraction when a run lacks per-segment costs to attribute. */
const FALLBACK_WASTE_RATIO = 0.15;

/**
 * Projected $ of flagged-wasteful work in one run — the cost of the
 * `attention`-severity segments the findings target. Falls back to a
 * conservative fraction of run cost only when no per-segment costs exist AND
 * there are findings. A projection, never a measured claim.
 */
export function projectedRunSavingsUsd(doc: AgentTraceDoc | null): number {
  if (!doc) return 0;
  let attentionCost = 0;
  let sawSegmentCost = false;
  for (const lane of doc.lanes ?? []) {
    for (const seg of lane.segments ?? []) {
      if (typeof seg.cost_usd === 'number') sawSegmentCost = true;
      if (seg.severity === 'attention') attentionCost += seg.cost_usd ?? 0;
    }
  }
  if (sawSegmentCost && attentionCost > 0) return attentionCost;
  const issues = (doc.summary?.issue_count ?? 0) + (doc.summary?.divergence_count ?? 0);
  return issues > 0 ? (doc.summary?.cost_usd ?? 0) * FALLBACK_WASTE_RATIO : 0;
}
