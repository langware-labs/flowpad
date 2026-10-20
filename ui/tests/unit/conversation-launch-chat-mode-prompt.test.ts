import { describe, expect, it } from 'vitest';

import { AgenticProcess } from '@sdk';
import { surfaceTransportGate } from '@src/components/terminal/interactive-terminal/use-process-surface';
import { sessionOpenViewMode } from '@src/contexts/view-mode-context';

/**
 * A launch that names no transport must start on the one its new session opens
 * in (`sessionOpenViewMode`). Otherwise a chat or vibe surface switches the
 * fresh PTY to headless, and that kill drops the un-run launch prompt (a
 * conversation's worker opened with an empty chat).
 */
describe('launch with a prompt and no stated transport', () => {
  it('starts on the transport its session opens in, so no switch kills its prompt', async () => {
    const calls: { config: { outputFormat?: string }; opts: { pty_mode?: boolean; launchPrompt?: string } }[] = [];
    const computeNode = {
      createProcess: async (config: { outputFormat?: string }, opts: { pty_mode?: boolean; launchPrompt?: string }) => {
        calls.push({ config, opts });
        return { isHeadless: opts.pty_mode === false, openTerminalDock: () => {} };
      },
    };

    const proc = await AgenticProcess.launch({
      computeNode: computeNode as never,
      workerType: 'claude_code',
      workdir: '/tmp/project',
      launchPrompt: 'report the conversation status',
    });

    const [{ config, opts }] = calls;
    expect(opts.launchPrompt).toBe('report the conversation status');
    expect(surfaceTransportGate(proc as never, sessionOpenViewMode(null)).needsSwitch).toBe(false);
    if (opts.pty_mode === false) expect(config.outputFormat).toBe('stream-json');
  });
});
