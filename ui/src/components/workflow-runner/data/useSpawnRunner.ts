/**
 * Spawn a new workflow runner subprocess.
 *
 * Extracted from `WorkflowAssetEditor.doRun` so the spawn logic doesn't
 * live in a .tsx file. The hook returns a function the caller invokes;
 * it owns the `dataContext` access + the `AgenticProcess` save+prompt
 * dance.
 *
 * The `useMcpAvailable` precondition check stays in the caller — different
 * UIs have different UX for the "MCP not installed" dialog.
 */

import { useCallback } from 'react';
import {
  AgenticProcess,
  ProcessKind,
  Workflow,
  dataContext,
} from '@sdk';
import { ClaudeCliOptions } from '@sdk/cli_workers/claude-cli';

interface SpawnInput {
  workflow: Workflow;
}

export interface UseSpawnRunnerResult {
  spawn: (input: SpawnInput) => Promise<AgenticProcess | null>;
}

export function useSpawnRunner(): UseSpawnRunnerResult {
  const spawn = useCallback(async ({ workflow }: SpawnInput) => {
    if (!workflow.asset_ref) return null;
    const systemSkills = dataContext.bootstrapInfo?.desktop_info?.paths?.system_skills;
    const flowSkillPath = systemSkills
      ? `/${systemSkills}/flow/SKILL.md`
      : '~/.flow/system_assets/skills/flow/SKILL.md';
    const instruction = `Run workflow at /${workflow.asset_ref} using the flow skill located at: ${flowSkillPath}`;
    const workdir = dataContext.project?.fs_storage_mount_path;

    const cliOptions = new ClaudeCliOptions({
      permission_mode: 'bypassPermissions',
      print_mode: true,
      output_format: 'stream-json',
      verbose: true,
    });
    const process = await new AgenticProcess({
      cli_config: cliOptions.toJson(),
      context_data: { project_id: dataContext.project?.id },
      workdir,
      visible: false,
      target_typeid_str: workflow.typeId.toString(),
      process_type: ProcessKind.Execution,
    }).save([workflow.typeId]);

    // Fire-and-forget — the streaming response is consumed elsewhere.
    void process.prompt(instruction);
    return process;
  }, []);

  return { spawn };
}
