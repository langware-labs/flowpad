export { WorkerCliOptions, shellQuote } from './base'
export { ClaudeCliOptions } from './claude-cli'
export type { ClaudeCliOptionsOptions } from './claude-cli'

import { WorkerCliOptions } from './base'
import { ClaudeCliOptions } from './claude-cli'

export function factory(cliJson: Record<string, any>, workerType: string): WorkerCliOptions {
  if (workerType === 'claude') return ClaudeCliOptions.fromJson(cliJson)
  throw new Error(`Unknown worker_type: ${workerType}`)
}
