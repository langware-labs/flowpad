export { WorkerCliOptions, shellQuote } from './base'
export { ClaudeCliOptions } from './claude-cli'
export type { ClaudeCliOptionsOptions } from './claude-cli'
export { CodexCliOptions } from './codex-cli'
export type { CodexCliOptionsOptions } from './codex-cli'
export { CopilotCliOptions } from './copilot-cli'
export type { CopilotCliOptionsOptions } from './copilot-cli'

import { WorkerCliOptions } from './base'
import { ClaudeCliOptions } from './claude-cli'
import { CodexCliOptions } from './codex-cli'
import { CopilotCliOptions } from './copilot-cli'

export function factory(cliJson: Record<string, any>, workerType: string): WorkerCliOptions {
  const normalized = workerType === 'claude_code' ? 'claude' : workerType
  if (normalized === 'claude') return ClaudeCliOptions.fromJson(cliJson)
  if (normalized === 'codex') return CodexCliOptions.fromJson(cliJson)
  if (normalized === 'copilot') return CopilotCliOptions.fromJson(cliJson)
  throw new Error(`Unknown worker_type: ${workerType}`)
}
