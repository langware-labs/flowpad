export { WorkerCLICommand, shellQuote } from './base'
export { ClaudeCLICommand } from './claude-cli'
export type { ClaudeCLICommandOptions } from './claude-cli'

import { WorkerCLICommand } from './base'
import { ClaudeCLICommand } from './claude-cli'

export function factory(cliJson: Record<string, any>, workerType: string): WorkerCLICommand {
  if (workerType === 'claude') return ClaudeCLICommand.fromJson(cliJson)
  throw new Error(`Unknown worker_type: ${workerType}`)
}
