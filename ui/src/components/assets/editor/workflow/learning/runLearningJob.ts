import { AgenticProcess, dataContext, FSRef, Workflow } from '@sdk';
import { ClaudeCliOptions } from '@sdk/cli_workers/claude-cli';
import { TypeId } from '@sdk/models/TypeId';

export function workflowDataDir(workflow: Workflow): string {
  const root = (dataContext as unknown as { recordsRoot?: string | null }).recordsRoot
    ?? dataContext.bootstrapInfo?.records_root;
  if (!root) throw new Error('recordsRoot not available');
  return `${root}/workflow/workflow-@${workflow.id}`;
}

export function workflowDataDirRef(workflow: Workflow): FSRef {
  const typeId = dataContext.computeNodeTypeId;
  if (!typeId) throw new Error('computeNodeTypeId not available');
  return new FSRef(workflowDataDir(workflow), typeId, 'folder');
}

function transcriptPathForRunner(runner: AgenticProcess): string | null {
  const project = runner.project_encoded_name;
  const session = runner.session_id;
  if (!project || !session) return null;
  return `~/.claude/projects/${project}/${session}.jsonl`;
}

function spawnHeadless(args: {
  instruction: string;
  workdir: string;
  scope: TypeId[];
  targetVfsPath: string;
}): Promise<AgenticProcess> {
  const cliOptions = new ClaudeCliOptions({
    permission_mode: 'bypassPermissions',
    print_mode: true,
    output_format: 'stream-json',
    verbose: true,
  });
  return new AgenticProcess({
    cli_config: cliOptions.toJson(),
    context_data: { project_id: dataContext.project?.id },
    workdir: args.workdir,
    visible: false,
    target_typeid_str: args.targetVfsPath,
  })
    .save(args.scope)
    .then((process) => {
      void process.prompt(args.instruction);
      return process;
    });
}

export async function runAnalyzer(args: {
  runner: AgenticProcess;
  workflow: Workflow;
}): Promise<AgenticProcess> {
  const out = args.runner.output_folder;
  if (!out?.path) throw new Error('Runner has no output_folder');
  const tracePath = `${out.path}/workflow.trace.jsonl`;
  const analysisPath = `${out.path}/workflow.analysis.jsonl`;
  const transcriptPath = transcriptPathForRunner(args.runner);
  if (!transcriptPath) throw new Error('Runner has no session_id / project_encoded_name');

  const instruction =
    `Use the \`session_analysis\` skill in Workflow Mode.\n\n` +
    `WORKFLOW_TRACE_PATH = ${tracePath}\n` +
    `TRANSCRIPT_PATH = ${transcriptPath}\n` +
    `OUTPUT_PATH = ${analysisPath}\n\n` +
    `Read the trace and transcript, identify per-anchor issues, write the ` +
    `analysis JSONL at OUTPUT_PATH (one record per anchor). Then output ` +
    `exactly: \`ANALYSIS WRITTEN: <count>\` as your final message.`;

  return spawnHeadless({
    instruction,
    workdir: workflowDataDir(args.workflow),
    scope: [args.workflow.typeId],
    targetVfsPath: `learning:analyze:${args.runner.id}`,
  });
}

export async function runLearner(args: {
  runner: AgenticProcess;
  workflow: Workflow;
  iteration: number;
}): Promise<AgenticProcess> {
  const out = args.runner.output_folder;
  if (!out?.path) throw new Error('Runner has no output_folder');
  const dd = workflowDataDir(args.workflow);
  const workflowAssetPath = args.workflow.asset_ref
    ? args.workflow.asset_ref.startsWith('/')
      ? args.workflow.asset_ref
      : `/${args.workflow.asset_ref}`
    : '';
  if (!workflowAssetPath) throw new Error('Workflow has no asset_ref');

  const instruction =
    `Use the \`workflow_learning\` skill.\n\n` +
    `WORKFLOW_PATH = ${workflowAssetPath}\n` +
    `LATEST_TRACE_PATH = ${out.path}/workflow.trace.jsonl\n` +
    `LATEST_ANALYSIS_PATH = ${out.path}/workflow.analysis.jsonl\n` +
    `CURRENT_MEMORY_PATH = ${dd}/memory.md\n` +
    `LEARNING_LOG_PATH = ${dd}/learning.log.md\n` +
    `FEEDBACK_PATH = ${dd}/feedback.md\n` +
    `ATTEMPT_COUNTER_HINT = ${args.iteration}\n\n` +
    `Follow the skill's protocol exactly. After writing the files, output ` +
    `exactly ONE final assistant line of the form:\n` +
    `  LEARNING WRITTEN: memory <bytes>, log <count> entries[, feedback]\n`;

  return spawnHeadless({
    instruction,
    workdir: dd,
    scope: [args.workflow.typeId],
    targetVfsPath: `learning:improve:${args.runner.id}`,
  });
}
