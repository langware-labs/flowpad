import { t } from '@lingui/core/macro';
import {
  AgentTrace,
  AgenticProcess,
  ComputeNode,
  ExpressionNode,
  ProcessKind,
  QueryFilter,
  QueryRequest,
  Skill,
} from '@sdk';
import { notify } from '@src/notifications';
import { basename } from '@src/components/asset-manager/asset-row-helpers';
import type { AgentTraceDoc, TraceFinding } from '../agent-trace/trace-types';

const SKILLIT_NAME = 'skillit';
const AGENT_TRACE_NAME = 'agent-trace';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * All skills indexed by name (non-React; the cache-first query makes repeat
 * calls cheap). Shared by the in-trace Evaluate path here and the tab-close
 * adapter so the "fetch all skills, index by name" logic lives in one place —
 * the reactive `useSkillsByName` hook mirrors this for React callers.
 */
export async function loadSkillsByName(): Promise<Map<string, Skill>> {
  const skills = await Skill.query<Skill>(new QueryRequest({ type: Skill.type, scope: [], name: 'skillsByName:all' }));
  return new Map(skills.map((s) => [s.name, s]));
}

/**
 * Shared createProcess → attach-skill → prompt triad behind every launcher below.
 * Resolves the skill to attach (surfacing a "not installed" error), spawns the
 * process with the given options, names it (so it isn't a bare id fragment in the
 * agentic-process footer), attaches the skill, and seeds the prompt.
 */
export async function runSkillWorker(
  attachSkillName: string,
  createOpts: Parameters<ComputeNode['createProcess']>[0],
  prompt: string,
  notInstalledTitle: string,
  processName?: string,
): Promise<AgenticProcess | null> {
  const skill = (await loadSkillsByName()).get(attachSkillName) ?? null;
  if (!skill) {
    notify.error({ title: notInstalledTitle, message: t`The "${attachSkillName}" skill is not installed.` });
    return null;
  }
  const computeNode = await ComputeNode.getById('@local');
  if (!computeNode) throw new Error('No local compute node');

  const proc: AgenticProcess = await computeNode.createProcess(createOpts);
  // Give the worker a human name up front — otherwise it shows as a bare id
  // fragment in the footer (these headless workers never hit the turn-end
  // seam that would stamp a default name from the generic seed prompt).
  // renameById pins auto_rename=false, so the name stays stable.
  if (processName) {
    try {
      await AgenticProcess.renameById(proc.id, processName);
    } catch (err) {
      console.error(`[skillWorker] name ${attachSkillName} process failed`, err);
    }
  }
  try {
    await proc.embeddedAssets.attach(skill.typeId.toString());
  } catch (err) {
    console.error(`[skillWorker] attach ${attachSkillName} failed`, err);
  }
  await proc.submit(prompt);
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

const assetProcessOpts = (
  targetTypeid: string,
  processType: ProcessKind,
  targetOverride?: string,
): Parameters<ComputeNode['createProcess']>[0] => ({
  targetVfsPath: targetOverride ?? targetTypeid,
  processType,
  outputFormat: 'stream-json',
  permissionMode: 'bypassPermissions',
});

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

export interface LaunchAssetAnalysisArgs {
  assetKey: string;
  assetTypeid: string;
  assetPath: string;
  assetLabel: string;
  issueRequest: string;
  sessionId: string;
  workerType: string;
}

export function launchAssetAnalysis({
  assetKey,
  assetTypeid,
  assetPath,
  assetLabel,
  issueRequest,
  sessionId,
  workerType,
}: LaunchAssetAnalysisArgs): Promise<AgenticProcess | null> {
  return runSkillWorker(
    AGENT_TRACE_NAME,
    assetProcessOpts(assetTypeid, ProcessKind.Analysis),
    `Use the agent-trace skill to analyze session ${sessionId} (worker type: ${workerType}) for a targeted asset improvement.\n\n` +
      `Asset:\n- key: ${assetKey}\n- typeid: ${assetTypeid}\n- label: ${assetLabel}\n- path: ${assetPath}\n\n` +
      `User requested fix:\n${issueRequest}\n\n` +
      `Do not edit files. Produce the AgentTrace record for this session. In trace.json, include verified findings under ` +
      `annotations.by_asset["${assetKey}"] with { asset_ref: "${assetPath}", typeid: "${assetTypeid}", findings: [...] }. ` +
      `Each finding must include concrete evidence from the transcript and be specific enough for a correction worker to apply.`,
    'Cannot analyze asset',
    `Improve ${assetLabel} — analyze`,
  );
}

export interface AssetAnalysisResult {
  trace: AgentTrace;
  findings: TraceFinding[];
}

function traceCreatedMs(trace: AgentTrace): number {
  const raw =
    (trace as unknown as { created_date?: string | Date; createdDate?: string | Date }).created_date ??
    (trace as unknown as { createdDate?: string | Date }).createdDate;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

async function readTraceDoc(trace: AgentTrace): Promise<AgentTraceDoc | null> {
  try {
    const raw = await trace.doc?.read();
    return raw ? (JSON.parse(raw) as AgentTraceDoc) : null;
  } catch {
    return null;
  }
}

/**
 * Pure bucket selection for a targeted-asset analysis: `annotations.by_asset`
 * keyed by the launch key (a mis-keyed but field-populated bucket is rescued
 * by the asset_ref/typeid scan). When the trace has NO by_asset at all — a
 * pre-by_asset analyzer — fall back to the legacy heuristic of the asset
 * main-file stem as a `by_skill` key (`vibe.md` → by_skill["vibe"]; only
 * meaningful for single-file agents — remove once pre-by_asset traces age
 * out). A present-but-empty by_asset bucket is a real "analyzer found
 * nothing" signal and does NOT fall through.
 */
export function selectAssetFindings(
  doc: AgentTraceDoc | null,
  sel: { assetKey: string; assetTypeid: string; assetPath: string },
): TraceFinding[] {
  const byAsset = doc?.annotations?.by_asset ?? {};
  const bucket =
    byAsset[sel.assetKey] ??
    Object.values(byAsset).find((value) => value.asset_ref === sel.assetPath || value.typeid === sel.assetTypeid);
  if (bucket || Object.keys(byAsset).length) return bucket?.findings ?? [];
  const stem = basename(sel.assetPath).replace(/\.[^.]+$/, '');
  return (stem && doc?.annotations?.by_skill?.[stem]?.findings) || [];
}

async function findAssetAnalysisResult(
  sessionId: string,
  assetKey: string,
  assetTypeid: string,
  assetPath: string,
  sinceMs: number,
): Promise<AssetAnalysisResult | null> {
  const traces = await AgentTrace.query<AgentTrace>(
    new QueryRequest({
      type: AgentTrace.type,
      scope: [],
      name: `agentTracesForAssetImprove:${sessionId}`,
      query: new QueryFilter({ match: new ExpressionNode({ session_id: sessionId }) }),
    }),
  );
  const ordered = [...traces].sort((a, b) => traceCreatedMs(b) - traceCreatedMs(a));
  for (const trace of ordered) {
    const created = traceCreatedMs(trace);
    if (created && created < sinceMs - 5000) continue;
    const doc = await readTraceDoc(trace);
    const findings = selectAssetFindings(doc, { assetKey, assetTypeid, assetPath });
    if (findings.length) return { trace, findings };
  }
  return null;
}

export async function waitForAssetAnalysisResult(args: {
  sessionId: string;
  assetKey: string;
  assetTypeid: string;
  assetPath: string;
  sinceMs: number;
  attempts?: number;
}): Promise<AssetAnalysisResult | null> {
  const attempts = args.attempts ?? 20;
  for (let i = 0; i < attempts; i += 1) {
    const result = await findAssetAnalysisResult(
      args.sessionId,
      args.assetKey,
      args.assetTypeid,
      args.assetPath,
      args.sinceMs,
    );
    if (result) return result;
    await sleep(1000);
  }
  return null;
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

export interface LaunchAssetCorrectArgs {
  assetKey: string;
  assetTypeid: string;
  assetPath: string;
  assetLabel: string;
  workdir: string;
  file: string;
  issueRequest: string;
  sessionId?: string | null;
  findings: unknown[];
  analysisTrace?: AgentTrace | null;
}

export function launchAssetCorrect({
  assetKey,
  assetTypeid,
  assetPath,
  assetLabel,
  workdir,
  file,
  issueRequest,
  sessionId,
  findings,
  analysisTrace,
}: LaunchAssetCorrectArgs): Promise<AgenticProcess | null> {
  if (!findings.length) {
    notify.error({ title: t`Nothing to improve`, message: t`No substantiated findings to apply for this asset.` });
    return Promise.resolve(null);
  }
  const ctx = sessionId ? ` (from analysis of session ${sessionId})` : '';
  return runSkillWorker(
    SKILLIT_NAME,
    assetProcessOpts(assetTypeid, ProcessKind.Execution, analysisTrace?.typeId.toString()),
    `Use the skillit skill in CORRECT mode on the asset "${assetLabel}".${ctx}\n\n` +
      `Asset identity:\n- key: ${assetKey}\n- typeid: ${assetTypeid}\n- asset path: ${assetPath}\n- working directory: ${workdir}\n- main file: ${file}\n\n` +
      `User requested fix:\n${issueRequest}\n\n` +
      `Apply these verified findings and edit the asset in place. Only edit files inside the asset path when it is a folder-backed asset; otherwise only edit the main file. ` +
      `Map each change to its finding and keep unrelated behavior unchanged.\n\n` +
      JSON.stringify(findings, null, 2),
    'Cannot improve asset',
    `Improve ${assetLabel} — apply`,
  );
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
    notify.error({ title: t`Nothing to improve`, message: t`No substantiated findings to apply for this skill.` });
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
