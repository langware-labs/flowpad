import os from 'node:os';
import path from 'node:path';

/**
 * Flowpad reads Claude transcripts through FLOWPAD_CLAUDE_HOME, while the
 * Claude CLI writes them through CLAUDE_CONFIG_DIR.  A live-worker test must
 * never let those roots diverge: recovery would misclassify an existing
 * session as fresh and relaunch it with --session-id instead of --resume.
 */
export function assertClaudeTranscriptHomesAligned(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = os.homedir(),
): void {
  const defaultClaudeHome = path.join(userHome, '.claude');
  const flowpadClaudeHome = path.resolve(env.FLOWPAD_CLAUDE_HOME || defaultClaudeHome);
  const claudeConfigDir = path.resolve(env.CLAUDE_CONFIG_DIR || defaultClaudeHome);

  if (flowpadClaudeHome !== claudeConfigDir) {
    throw new Error(
      'Claude transcript roots are misaligned: ' +
        `FLOWPAD_CLAUDE_HOME resolves to ${flowpadClaudeHome}, but ` +
        `CLAUDE_CONFIG_DIR resolves to ${claudeConfigDir}. ` +
        'Set both to the same cycle-owned directory before running API tests.',
    );
  }
}
