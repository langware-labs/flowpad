/**
 * System Skills — Integration Test
 *
 * Verifies that bundled system skills (flow, compile-workflow, session_analysis)
 * are visible to Claude via --add-dir system_assets.
 *
 * Requires: running backend at localhost:9007 + Claude Code installed
 * Timeout: 180s (real Claude subprocess)
 */

import { FlowData, apiClient } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, get_local_compute_node, getTestSignupInfo } from '../utils/test-utils';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const SYSTEM_SKILLS = ['flow', 'compile-workflow', 'session_analysis'];

describe('system skills visible via --add-dir', () => {
  beforeEach(async (ctx: any) => {
    await apiTestSetup(getTestSignupInfo(), ctx.task.name);
  });

  it('lists system skills in Claude subprocess', async () => {
    const computeNode = await get_local_compute_node();
    expect(computeNode, 'local compute node must exist').toBeTruthy();

    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-skills-test-'));

    // Create process with a fresh workdir
    const processor = await computeNode.createAgenticProcessor();
    const agenticProcess = await processor.createProcess({
      workdir,
      permissionMode: 'bypassPermissions',
    });
    await agenticProcess.watch();

    console.log(`[system_skills] created process ${agenticProcess.id}, workdir=${workdir}`);

    let completionStatus: 'complete' | 'error' | null = null;
    agenticProcess.on('complete', () => {
      completionStatus = 'complete';
      console.log('[system_skills] process complete');
    });
    agenticProcess.on('error', (err: any) => {
      completionStatus = 'error';
      console.error('[system_skills] process error:', err);
    });

    const flowItems: FlowData[] = [];
    const collectPromise = (async () => {
      for await (const item of agenticProcess.output()) {
        flowItems.push(item);
      }
    })();

    const instruction =
      'Look in the .claude/skills/ directory and list all skill directory names. ' +
      'Output them as a JSON array to skills.json — one entry per directory name. ' +
      'Write only the JSON array, nothing else.';

    await agenticProcess.executeInstruction(instruction, { sync: false });

    await Promise.race([
      collectPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('System skills test timed out after 150s')), 150_000),
      ),
    ]);

    expect(completionStatus).toBe('complete');

    const skillsFile = path.join(workdir, 'skills.json');
    expect(fs.existsSync(skillsFile), `skills.json not found at ${skillsFile}`).toBe(true);

    const skills: string[] = JSON.parse(fs.readFileSync(skillsFile, 'utf8'));
    expect(Array.isArray(skills), 'Expected JSON array').toBe(true);

    const names = skills.map((s) => String(s).toLowerCase());
    console.log('[system_skills] found skills:', names);

    for (const expected of SYSTEM_SKILLS) {
      expect(
        names.some((n) => n.includes(expected)),
        `System skill '${expected}' not found in: ${JSON.stringify(names)}`,
      ).toBe(true);
    }
  }, 180_000);
});
