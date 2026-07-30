export { WorkerCliOptions, shellQuote } from './base'
export { ClaudeAgentOptions } from './claude-cli'
export type { ClaudeAgentOptionsOptions } from './claude-cli'
export { CodexAgentOptions } from './codex-cli'
export type { CodexAgentOptionsOptions } from './codex-cli'
export { CopilotAgentOptions } from './copilot-cli'
export type { CopilotAgentOptionsOptions } from './copilot-cli'

import { WorkerCliOptions } from './base'
import { ClaudeAgentOptions } from './claude-cli'
import { CodexAgentOptions } from './codex-cli'
import { CopilotAgentOptions } from './copilot-cli'

export function factory(cliJson: Record<string, any>, workerType: string): WorkerCliOptions {
  const normalized = workerType === 'claude_code' ? 'claude' : workerType
  if (normalized === 'claude') return ClaudeAgentOptions.fromJson(cliJson)
  if (normalized === 'codex') return CodexAgentOptions.fromJson(cliJson)
  if (normalized === 'copilot') return CopilotAgentOptions.fromJson(cliJson)
  throw new Error(`Unknown worker_type: ${workerType}`)
}
