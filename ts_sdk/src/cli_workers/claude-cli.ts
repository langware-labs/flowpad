/**
 * ClaudeCLICommand — builds Claude Code CLI shell command strings.
 *
 * Mirrors Python flow_sdk/builtin/cli_workers/claude_cli.py exactly.
 * All fields map 1-to-1 to CLI flags. Snake_case field names match
 * the serialized cli_config dict from the backend.
 */

import { WorkerCLICommand, shellQuote } from './base'

export interface ClaudeCLICommandOptions {
  session_id?: string | null
  resume?: boolean
  fork_session_id?: string | null
  model?: string | null
  debug?: boolean
  permission_mode?: string
  chrome?: boolean
  worktree?: boolean
  agents_json?: Record<string, any> | null
  workdir?: string
  env_vars?: Record<string, string>
}

export class ClaudeCLICommand extends WorkerCLICommand {
  session_id?: string | null
  resume: boolean
  fork_session_id?: string | null
  model?: string | null
  debug: boolean
  permission_mode: string
  chrome: boolean
  worktree: boolean
  agents_json?: Record<string, any> | null

  constructor(opts: ClaudeCLICommandOptions = {}) {
    super(opts.workdir ?? undefined, opts.env_vars)
    this.session_id = opts.session_id ?? undefined
    this.resume = opts.resume ?? false
    this.fork_session_id = opts.fork_session_id ?? undefined
    this.model = opts.model ?? undefined
    this.debug = opts.debug ?? true
    this.permission_mode = opts.permission_mode ?? 'bypassPermissions'
    this.chrome = opts.chrome ?? false
    this.worktree = opts.worktree ?? false
    this.agents_json = opts.agents_json ?? undefined

    // Auto-inject CLAUDE_PROJECT_DIR from workdir (same as Python setdefault)
    if (opts.workdir) {
      this.envVars['CLAUDE_PROJECT_DIR'] ??= opts.workdir
    }
  }

  protected _buildWorkerArgs(): string[] {
    const args: string[] = ['claude']

    if (this.permission_mode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions')
    }
    if (this.chrome) args.push('--chrome')
    if (this.debug) args.push('--debug')
    if (this.worktree) args.push('--worktree')

    if (this.resume && this.session_id) {
      args.push(`--resume ${shellQuote(this.session_id)}`)
      if (this.fork_session_id) {
        args.push('--fork-session')
        args.push(`--session-id ${shellQuote(this.fork_session_id)}`)
      }
    } else if (this.session_id) {
      args.push(`--session-id ${shellQuote(this.session_id)}`)
    }

    if (this.model) args.push(`--model ${shellQuote(this.model)}`)
    if (this.agents_json) args.push(`--agents ${shellQuote(JSON.stringify(this.agents_json))}`)

    return args
  }

  toJson(): Record<string, any> {
    return {
      ...super.toJson(),
      worker_type: 'claude',
      session_id: this.session_id,
      resume: this.resume,
      fork_session_id: this.fork_session_id,
      model: this.model,
      debug: this.debug,
      permission_mode: this.permission_mode,
      chrome: this.chrome,
      worktree: this.worktree,
      agents_json: this.agents_json,
    }
  }

  static fromJson(data: Record<string, any>): ClaudeCLICommand {
    return new ClaudeCLICommand({
      session_id: data['session_id'] ?? undefined,
      resume: Boolean(data['resume'] ?? false),
      fork_session_id: data['fork_session_id'] ?? undefined,
      model: data['model'] ?? undefined,
      debug: data['debug'] !== undefined ? Boolean(data['debug']) : true,
      permission_mode: data['permission_mode'] ?? 'bypassPermissions',
      chrome: Boolean(data['chrome'] ?? false),
      worktree: Boolean(data['worktree'] ?? false),
      agents_json: data['agents_json'] ?? undefined,
      workdir: data['workdir'] ?? undefined,
      env_vars: data['env_vars'] ?? {},
    })
  }
}
