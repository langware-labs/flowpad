/**
 * The Playwright agentic-process matrix skips the `--chrome` / `--debug` /
 * `--worktree` scenarios on non-claude arms via a hand-written constant
 * (`AP_HAS_CLAUDE_ONLY_CLI_FLAGS` in `_ap_helpers.ts`), because that helper
 * cannot import the presentation module — it pulls in `@lingui/core/macro`,
 * which Playwright's transpiler does not expand.
 *
 * That makes the constant a second, independent encoding of a product fact, and
 * a silent skip is the worst failure mode a test can have: a vendor that later
 * gains these flags would keep skipping and stay green by not running. This
 * test is the seam that stops that — it runs under vitest, where the macro DOES
 * expand, and asserts the two agree for every vendor the matrix can drive.
 */
import { describe, expect, it } from 'vitest';
import { getWorkerCliCapabilities } from '@src/components/terminal/interactive-terminal/process-cli-presentation';

// Mirrors `_ap_helpers.ts`: AP_OPENER selects the row, AP_WORKER_TYPE names the
// same vendor as a WorkerType.
const OPENERS: Record<string, string> = {
  claude: 'claude_code',
  codex: 'codex',
  copilot: 'copilot',
  opencode: 'opencode',
};

describe('AP_HAS_CLAUDE_ONLY_CLI_FLAGS agrees with the product', () => {
  for (const [opener, workerType] of Object.entries(OPENERS)) {
    it(`${opener}: the helper's "claude only" claim matches getWorkerCliCapabilities`, () => {
      const caps = getWorkerCliCapabilities(workerType);
      const derived = caps.chrome && caps.debug && caps.worktree;
      // The literal the Playwright helper hardcodes.
      const hardcoded = opener === 'claude';
      expect(derived).toBe(hardcoded);
    });
  }

  it('every vendor still offers Full Trust — that part is a shared contract', () => {
    for (const workerType of Object.values(OPENERS)) {
      expect(getWorkerCliCapabilities(workerType).fullTrust).toBe(true);
    }
  });
});
