import {
  AgentTrace,
  AgenticProcess,
  ComputeNode,
  ProcessKind,
  QueryRequest,
  Skill,
} from '@sdk';
import { notify } from '@src/notifications';
import { launchWorkerWithAsset } from '@src/components/workers/launchWorkerWithAsset';
import type { WorkerType } from '@src/components/workers/worker-types';

const SKILLIT_NAME = 'skillit';
const AGENT_TRACE_NAME = 'agent-trace';

/**
 * All skills indexed by name (non-React; the cache-first query makes repeat
 * calls cheap). Shared by the in-trace Evaluate path here and the tab-close
 * adapter so the "fetch all skills, index by name" logic lives in one place —
 * the reactive `useSkillsByName` hook mirrors this for React callers.
 */
export async function loadSkillsByName(): Promise<Map<string, Skill>> {
  const skills = await Skill.query<Skill>(
    new QueryRequest({ type: Skill.type, scope: [], name: 'skillsByName:all' }),
  );
  return new Map(skills.map((s) => [s.name, s]));
}

/**
 * Shared createProcess → attach-skill → prompt triad behind every launcher below.
 * Resolves the skill to attach (surfacing a "not installed" error), spawns the
 * process with the given options, attaches the skill, and seeds the prompt.
 */
async function runSkillWorker(
  attachSkillName: string,
  createOpts: Parameters<ComputeNode['createProcess']>[0],
  prompt: string,
  notInstalledTitle: string,
): Promise<AgenticProcess | null> {
  const skill = (await loadSkillsByName()).get(attachSkillName) ?? null;
  if (!skill) {
    notify.error({ title: notInstalledTitle, message: `The "${attachSkillName}" skill is not installed.` });
    return null;
  }
  const computeNode = await ComputeNode.getById('@local');
  if (!computeNode) throw new Error('No local compute node');

  const proc: AgenticProcess = await computeNode.createProcess(createOpts);
  try {
    await proc.embeddedAssets.attach(skill.typeId.toString());
  } catch (err) {
    console.error(`[skillWorker] attach ${attachSkillName} failed`, err);
  }
  void proc.prompt(prompt);
  return proc;
}

/** Process spawned per skill, keyed to its TypeId so it surfaces in that skill's
 * `EntityExecutionPanel` history — unless `targetOverride` re-keys it (e.g. to an
 * analysis trace so the run surfaces as that analysis's improvement). */
const skillProcessOpts = (
  targetSkill: Skill,
  targetOverride?: string,
): Parameters<ComputeNode['createProcess']>[0] => ({
  targetVfsPath: targetOverride ?? targetSkill.typeId.toString(),
  processType: ProcessKind.Execution,
  outputFormat: 'stream-json',
  permissionMode: 'bypassPermissions',
});

/**
 * Spin up an **interactive** worker so the author can test the skill by hand —
 * the "quick start testing" toolbar next to the eval flag.
 *
 * Unlike {@link launchSkillEval} (which auto-prompts `skillit` in a stream-json
 * execution process), this opens a real interactive terminal tab via the shared
 * {@link launchWorkerWithAsset} helper in **staged** mode: the worker boots idle
 * and a starter prompt sits on the queue (draining disabled) for the author to
 * send. The skill is referenced by name so the harness discovers the installed
 * skill on boot (see the helper's note on why `embeddedAssets.attach` can't run
 * pre-boot for an interactive tab).
 */
export async function launchSkillTest(
  targetSkill: Skill,
  workerType: WorkerType,
): Promise<AgenticProcess | null> {
  try {
    return await launchWorkerWithAsset({
      workerType,
      seedPrompt: `Let's test the "${targetSkill.name}" skill. `,
      stage: true,
      enqueueSource: 'skill-test',
    });
  } catch (err) {
    notify.error({
      title: 'Could not start test worker',
      message: err instanceof Error ? err.message : 'Failed to launch worker.',
    });
    return null;
  }
}

export interface LaunchSkillEvalArgs {
  /** The skill being evaluated — the analysis process is keyed to its TypeId. */
  targetSkill: Skill;
  /** The closed run that used the skill (for the analysis prompt context). */
  sourceProcessId?: string | null;
  /** The closed run's session id (for the analysis prompt context). */
  sessionId?: string | null;
}

/**
 * Launch a skillit-analysis agentic process that evaluates how `targetSkill` was
 * used in a run. Hook-free so both the in-trace Evaluate button (React) and the
 * tab-close adapter (non-React) call it.
 */
export function launchSkillEval({
  targetSkill,
  sourceProcessId,
  sessionId,
}: LaunchSkillEvalArgs): Promise<AgenticProcess | null> {
  const ctx = sourceProcessId
    ? ` Context: it was just used in the closed run ${sourceProcessId}${sessionId ? ` (session ${sessionId})` : ''}.`
    : '';
  return runSkillWorker(
    SKILLIT_NAME,
    skillProcessOpts(targetSkill),
    `Use the skillit skill to evaluate the skill "${targetSkill.name}".${ctx} ` +
      `Review how this skill is written and how it was used, against skill-writing best practices, and report findings.`,
    'Cannot evaluate skill',
  );
}

/**
 * Launch the **agent-trace** analyzer on a past session (the "analyze" step of
 * the asset improvement cycle). Produces an `AgentTrace` record keyed to
 * `sessionId` (with verified per-asset `by_skill` findings), surfaced by
 * `useSessionAnalyses(sessionId)`.
 */
export function launchSessionAnalysis(
  sessionId: string,
  workerType: string = 'claude',
): Promise<AgenticProcess | null> {
  return runSkillWorker(
    AGENT_TRACE_NAME,
    { processType: ProcessKind.Analysis, outputFormat: 'stream-json', permissionMode: 'bypassPermissions' },
    `Use the agent-trace skill to analyze session ${sessionId} (worker type: ${workerType}) ` +
      `and produce the AgentTrace record.`,
    'Cannot analyze session',
  );
}

export interface LaunchSkillCorrectArgs {
  /** The skill being corrected — the process is keyed to its TypeId. */
  targetSkill: Skill;
  /** The analyzed session (for the correction prompt context). */
  sessionId?: string | null;
  /** The verified per-asset findings (`AgentTrace.annotations.by_skill[<skill>].findings`). */
  findings: unknown[];
  /**
   * When set, key the improvement process to this analysis trace's TypeId instead
   * of the skill's — so it surfaces as that analysis's improvement
   * (`useProcessesForTarget(trace.typeId, Execution)`), the "attached to the
   * analysis" link the terminal Analysis side-window relies on.
   */
  analysisTrace?: AgentTrace | null;
}

/**
 * Launch skillit in **correct mode** fed the analysis's verified per-asset
 * findings (the "improve" step). The worker edits `SKILL.md` in place; the
 * caller commits the result via the `commit-asset` action once it finishes.
 */
export function launchSkillCorrect({
  targetSkill,
  sessionId,
  findings,
  analysisTrace,
}: LaunchSkillCorrectArgs): Promise<AgenticProcess | null> {
  if (!findings.length) {
    notify.error({ title: 'Nothing to improve', message: 'No substantiated findings to apply for this skill.' });
    return Promise.resolve(null);
  }
  const ctx = sessionId ? ` (from analysis of session ${sessionId})` : '';
  return runSkillWorker(
    SKILLIT_NAME,
    skillProcessOpts(targetSkill, analysisTrace?.typeId.toString()),
    `Use the skillit skill in CORRECT mode on the skill "${targetSkill.name}".${ctx} ` +
      `Apply these per-asset findings, mapping each fix to its issue, and edit the skill in place:\n\n` +
      JSON.stringify(findings, null, 2),
    'Cannot improve skill',
  );
}
