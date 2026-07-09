/**
 * ClaudeCliOptions — builds Claude Code CLI shell command strings.
 *
 * Mirrors Python flow_sdk/builtin/cli_workers/claude_cli.py exactly.
 * All fields map 1-to-1 to CLI flags. Snake_case field names match
 * the serialized cli_config dict from the backend.
 */

import { WorkerCliOptions, shellQuote } from './base'

const CLAUDE_MODEL_TIERS: Record<string, string> = {
  sm: 'haiku',
  md: 'sonnet',
  lg: 'opus',
}

export interface ClaudeCliOptionsOptions {
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
  add_dirs?: string[]
  print_mode?: boolean
  /** One of "text" | "json" | "stream-json"; omit for CLI default. */
  output_format?: string | null
  /** Required when output_format === "stream-json"; auto-enabled in that case. */
  verbose?: boolean
}

export class ClaudeCliOptions extends WorkerCliOptions {
  session_id?: string | null
  resume: boolean
  fork_session_id?: string | null
  model?: string | null
  debug: boolean
  permission_mode: string
  chrome: boolean
  worktree: boolean
  agents_json?: Record<string, any> | null
  addDirs: string[]
  print_mode: boolean
  output_format?: string | null
  verbose: boolean

  constructor(opts: ClaudeCliOptionsOptions = {}) {
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
    this.addDirs = opts.add_dirs ?? []
    this.print_mode = opts.print_mode ?? false
    this.output_format = opts.output_format ?? undefined
    this.verbose = (opts.verbose ?? false) || opts.output_format === 'stream-json'

    // Auto-inject CLAUDE_PROJECT_DIR from workdir (same as Python setdefault)
    if (opts.workdir) {
      this.envVars['CLAUDE_PROJECT_DIR'] ??= opts.workdir
    }
  }

  get resolvedModel(): string | undefined {
    return this.model ? (CLAUDE_MODEL_TIERS[this.model] ?? this.model) : undefined
  }

  protected _buildWorkerArgs(): string[] {
    const args: string[] = ['claude']

    if (this.permission_mode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions')
    }
    if (this.chrome) args.push('--chrome')
    if (this.debug) args.push('--debug')
    if (this.worktree) args.push('--worktree')
    if (this.verbose) args.push('--verbose')
    if (this.output_format) args.push(`--output-format ${shellQuote(this.output_format)}`)

    if (this.resume && this.session_id) {
      args.push(`--resume ${shellQuote(this.session_id)}`)
      if (this.fork_session_id) {
        args.push('--fork-session')
        args.push(`--session-id ${shellQuote(this.fork_session_id)}`)
      }
    } else if (this.session_id) {
      args.push(`--session-id ${shellQuote(this.session_id)}`)
    }

    if (this.resolvedModel) args.push(`--model ${shellQuote(this.resolvedModel)}`)
    if (this.agents_json) args.push(`--agents ${shellQuote(JSON.stringify(this.agents_json))}`)
    for (const d of this.addDirs) {
      args.push(`--add-dir ${shellQuote(d)}`)
    }
    if (this.print_mode) args.push('-p')

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
      add_dirs: this.addDirs,
      print_mode: this.print_mode,
      output_format: this.output_format,
      verbose: this.verbose,
    }
  }

  static fromJson(data: Record<string, any>): ClaudeCliOptions {
    return new ClaudeCliOptions({
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
      add_dirs: data['add_dirs'] ?? [],
      print_mode: Boolean(data['print_mode'] ?? false),
      output_format: data['output_format'] ?? undefined,
      verbose: Boolean(data['verbose'] ?? false),
    })
  }
}
