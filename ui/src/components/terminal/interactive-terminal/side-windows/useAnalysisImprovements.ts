import { t } from '@lingui/core/macro';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type AgentTrace, type FSRef, ProcessKind, type Skill, type WorkerStatus, isWorkerRunning } from '@sdk';
import { useAgentTraceDoc } from '@src/components/assets/editor/agent-trace/useAgentTraceDoc';
import type { TraceFinding } from '@src/components/assets/editor/agent-trace/trace-types';
import { useProcessesForTarget } from '@src/components/entity-execution-panel/hooks/useProcessesForTarget';
import { useSkillsByName } from '@src/hooks/useSkillsByName';
import { getGitStatus } from '@src/lib/git-status-cache';
import { notify } from '@src/notifications';
import { launchSkillCorrect } from '@src/components/assets/editor/skill/skill-eval-analysis';
import { deriveImproveStatus, improvableSkills, skillFileIsDirty, type ImproveStatus } from './analysis-improvements';

export type { ImproveStatus };

export interface SkillImproveState {
  skillName: string;
  findings: TraceFinding[];
  /** Resolved Skill entity (null while skills load or if not installed). */
  skill: Skill | null;
  /** SKILL.md ref — drives the diff/commit/discard. */
  skillFile: FSRef | null;
  status: ImproveStatus;
  /** Working tree has uncommitted edits to this skill — an improvement to review. */
  dirty: boolean;
  /** Safe to improve: skill installed, file clean (so the diff is purely the fix). */
  canImprove: boolean;
}

/**
 * Per-analysis improvement state for the terminal Analysis side-window. Reads the
 * trace's `by_skill` findings, resolves each improvable skill, tracks improvement
 * runs keyed to the trace (`useProcessesForTarget(trace.typeId, Execution)`), and
 * exposes `improve(skillName)` (skillit CORRECT, attached to this analysis).
 *
 * Completion is read off the working tree: improve is gated on a clean SKILL.md,
 * so once the file is dirty there's an improvement to review.
 */
export function useAnalysisImprovements(trace: AgentTrace | null) {
  const { doc } = useAgentTraceDoc(trace?.doc ?? null);
  const { byName } = useSkillsByName();

  const traceKey = trace?.typeId.toString() ?? null;
  const { processes } = useProcessesForTarget(traceKey, { processType: ProcessKind.Execution });
  const anyRunning = useMemo(
    () => processes.some((p) => isWorkerRunning(p.worker_status as WorkerStatus)),
    [processes],
  );

  // Skills the user kicked off an improvement for this session (drives 'running'
  // until the working tree shows the edit).
  const [launched, setLaunched] = useState<Set<string>>(() => new Set());
  // skillName → working-tree dirty for its SKILL.md.
  const [dirtyBySkill, setDirtyBySkill] = useState<Record<string, boolean>>({});
  const [dirtyTick, setDirtyTick] = useState(0);

  const improvable = useMemo(() => improvableSkills(doc), [doc]);

  // Refresh per-skill dirtiness whenever the improvable set, run activity, or an
  // explicit refresh (post commit/discard) changes. getGitStatus is cached +
  // single-flight, so repeated/duplicate (node, workdir) lookups are cheap.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: Record<string, boolean> = {};
      await Promise.all(
        improvable.map(async ({ skillName }) => {
          const skillFile = byName.get(skillName)?.doc ?? null;
          if (!skillFile) return;
          try {
            const st = await getGitStatus(skillFile.typeId.id, skillFile.parent.path);
            next[skillName] = skillFileIsDirty(st?.files ?? [], skillFile.path);
          } catch {
            /* leave undefined → treated as not-dirty */
          }
        }),
      );
      if (!cancelled) setDirtyBySkill(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [improvable, byName, anyRunning, dirtyTick]);

  const skills: SkillImproveState[] = useMemo(
    () =>
      improvable.map(({ skillName, findings }) => {
        const skill = byName.get(skillName) ?? null;
        const skillFile = skill?.doc ?? null;
        const dirty = !!dirtyBySkill[skillName];
        const status = deriveImproveStatus({ dirty, launched: launched.has(skillName), anyRunning });
        return {
          skillName,
          findings,
          skill,
          skillFile,
          status,
          dirty,
          canImprove: !!skill && !dirty,
        };
      }),
    [improvable, byName, dirtyBySkill, launched, anyRunning],
  );

  const improve = useCallback(
    async (skillName: string) => {
      const skill = byName.get(skillName) ?? null;
      const entry = improvable.find((e) => e.skillName === skillName);
      if (!skill || !entry || !trace) {
        notify.error({ title: t`Cannot improve`, message: t`The "${skillName}" skill is not installed.` });
        return;
      }
      if (dirtyBySkill[skillName]) {
        notify.warning({
          title: t`Commit or discard first`,
          message: t`This skill has uncommitted changes — improve runs only on a clean skill.`,
        });
        return;
      }
      setLaunched((prev) => new Set(prev).add(skillName));
      await launchSkillCorrect({
        targetSkill: skill,
        sessionId: trace.session_id,
        findings: entry.findings,
        analysisTrace: trace,
      });
    },
    [byName, improvable, dirtyBySkill, trace],
  );

  const refreshDirty = useCallback(() => setDirtyTick((x) => x + 1), []);

  // `doc` feeds the modal's projected-value headline (attention-cost from the trace).
  return { skills, improve, refreshDirty, doc };
}
