import {
  AgenticProcess,
  ComputeNode,
  ProcessKind,
  QueryRequest,
  Skill,
} from '@sdk';
import { notify } from '@src/notifications';

const SKILLIT_NAME = 'skillit';

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
 * tab-close adapter (non-React) call it. Mirrors the createProcess → attach →
 * prompt triad of `useRunOnFile` / `RunAutomationPanel`.
 *
 * The process is keyed to the skill's TypeId (`target_typeid_str`), so every
 * analysis surfaces in that skill's `EntityExecutionPanel` history — one history
 * thread per evaluated skill (one analysis per flagged skill falls out naturally).
 */
export async function launchSkillEval({
  targetSkill,
  sourceProcessId,
  sessionId,
}: LaunchSkillEvalArgs): Promise<AgenticProcess | null> {
  const skillit = (await loadSkillsByName()).get(SKILLIT_NAME) ?? null;
  if (!skillit) {
    notify.error({
      title: 'Cannot evaluate skill',
      message: `The "${SKILLIT_NAME}" skill is not installed.`,
    });
    return null;
  }

  const computeNode = await ComputeNode.getById('@local');
  if (!computeNode) throw new Error('No local compute node');

  const proc: AgenticProcess = await computeNode.createProcess({
    targetVfsPath: targetSkill.typeId.toString(),
    processType: ProcessKind.Execution,
    outputFormat: 'stream-json',
    permissionMode: 'bypassPermissions',
  });

  try {
    await proc.embeddedAssets.attach(skillit.typeId.toString());
  } catch (err) {
    console.error('[skillEval] attach skillit failed', err);
  }

  const ctx = sourceProcessId
    ? ` Context: it was just used in the closed run ${sourceProcessId}${sessionId ? ` (session ${sessionId})` : ''}.`
    : '';
  const instruction =
    `Use the skillit skill to evaluate the skill "${targetSkill.name}".${ctx} ` +
    `Review how this skill is written and how it was used, against skill-writing best practices, and report findings.`;

  void proc.prompt(instruction);
  return proc;
}
