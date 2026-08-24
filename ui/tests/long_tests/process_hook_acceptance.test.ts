/** Shared real-worker acceptance for process-local UserPromptSubmit hooks. */
import { AgenticProcess, HookEventType, type AgentHookData } from '@sdk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import contract from '../../../tests/fixtures/process_hook_acceptance.json';
import { apiTestSetup } from '../utils/test-utils';

function unavailableWorkerOutput(process: AgenticProcess): string | null {
  const output = process
    .getOutputs()
    .map((item) => String(item.data ?? item.content ?? ''))
    .join('\n');
  return /(not logged in|invalid api key|binary not found|spawn failed|hit your limit|weekly limit|usage limit|rate limit|quota|too many requests|overloaded)/i.test(
    output,
  )
    ? output
    : null;
}

const vendors = ['claude_code', 'codex', 'copilot'] as const;

describe('process hook shared real-worker acceptance', () => {
  it.each(vendors)('%s: setHook → registerCallback → prompt delivers one canonical hook', async (workerType) => {
    await apiTestSetup(undefined, `process-hook-${workerType}`);
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'process-hook-acceptance-'));
    const cliConfig: Record<string, unknown> = { permission_mode: 'bypassPermissions' };
    if (workerType !== 'copilot') cliConfig.model = 'sm';
    if (workerType === 'claude_code') cliConfig.effort = 'low';
    const process = await new AgenticProcess({
      worker_type: workerType,
      workdir,
      visible: false,
      pty_mode: false,
      load_flowpad_assistant: false,
      cli_config: cliConfig,
    }).save([]);

    let unwatch: (() => Promise<void>) | undefined;
    let unsubscribe = () => {};
    let hookConfigured = false;
    const reports: AgentHookData[] = [];
    try {
      unwatch = await process.watch();
      expect(await process.setHook(HookEventType.USER_PROMPT_SUBMIT)).toBe(true);
      hookConfigured = true;
      unsubscribe = process.registerCallback((data) => {
        reports.push(data);
      });

      const rehydrated = await AgenticProcess.getById(process.id);
      expect(rehydrated?.process_hook_events).toEqual([contract.expected_persisted_event]);

      await process.prompt(contract.prompt);

      const unavailable = reports.length === 0 ? unavailableWorkerOutput(process) : null;
      expect(reports, unavailable ? `${workerType} unavailable: ${unavailable.slice(0, 240)}` : undefined).toHaveLength(
        1,
      );
      const [report] = reports;
      expect(report.agentic_process_id).toBe(process.id);
      expect(report.hook_data.hook_event_name).toBe(contract.event);
      expect(report.hook_data.prompt).toBe(contract.expected_callback_prompt);
      expect(report.hook_data.session_id).toBeTruthy();
      const vendor = contract.vendors[workerType];
      expect((report.hook_data.raw_hook_data as Record<string, unknown>).prompt).toBe(
        contract.prompt + vendor.raw_prompt_suffix,
      );

      const fresh = await AgenticProcess.getById(process.id);
      expect(fresh?.assets_folder).toBeTruthy();
      if (workerType === 'codex') {
        expect(await fresh!.assets_folder!.child('.flowpad/plugins/codex').exists()).toBe(false);
      } else {
        const plugin = fresh!.assets_folder!.child(vendor.plugin_relative_path!);
        for (const relative of vendor.plugin_files) {
          expect(await plugin.child(relative).exists(), relative).toBe(true);
        }
        if (workerType === 'claude_code') {
          const hooks = JSON.parse(await plugin.child('hooks/hooks.json').read()) as {
            hooks: Record<string, Array<{ hooks: Array<{ args: string[] }> }>>;
          };
          // The contract event (UserPromptSubmit) is response-capable, so the
          // projected handler blocks on the backend round trip — see
          // `_RESPONSE_EVENTS` in flow_sdk/.../cli_drivers/claude/driver.py.
          // This tail assertion predates that projection (commit 4e1482ede)
          // and is checked here at full width rather than weakened.
          expect(hooks.hooks[contract.event][0].hooks[0].args.slice(-5)).toEqual([
            'hooks',
            'report',
            '--process-id',
            process.id,
            '--wait-for-response',
          ]);
        } else {
          const hooks = JSON.parse(await plugin.child('hooks.json').read()) as {
            hooks: Record<string, Array<{ bash: string; powershell: string }>>;
          };
          const handler = hooks.hooks[contract.vendors.copilot.config_event][0];
          expect(`${handler.bash}\n${handler.powershell}`).toContain(`--process-id ${process.id}`);
        }
      }

      expect(await process.removeHook(HookEventType.USER_PROMPT_SUBMIT)).toBe(true);
      hookConfigured = false;
      unsubscribe();
      unsubscribe();
    } finally {
      if (hookConfigured) await process.removeHook(HookEventType.USER_PROMPT_SUBMIT).catch(() => {});
      unsubscribe();
      await unwatch?.().catch(() => {});
      await process.delete().catch(() => {});
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });
});
