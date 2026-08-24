import { WorkerCliOptions, shellQuote } from './base'
import { OPENCODE_MODEL_TIERS, resolveModelTier } from './model-tiers'

export interface OpenCodeAgentOptionsOptions {
  session_id?: string | null
  resume?: boolean
  fork_session_id?: string | null
  model?: string | null
  permission_mode?: string
  agent?: string | null
  variant?: string | null
  skill_names?: string[]
  workdir?: string
  env_vars?: Record<string, string>
  add_dirs?: string[]
  json_stream?: boolean
}

/**
 * Mirror of the Python `OpenCodeAgentOptions`.
 *
 * Two shapes that differ from every other vendor here:
 * - there is NO `--add-dir`; extra roots and instruction assets reach the
 *   worker through a generated config file pointed at by `OPENCODE_CONFIG`;
 * - `--session` only CONTINUES an existing session (opencode exits 1 with
 *   "Session not found" otherwise), so a session id is only ever emitted on a
 *   resume — never to create one.
 */
export class OpenCodeAgentOptions extends WorkerCliOptions {
  session_id?: string | null
  resume: boolean
  fork_session_id?: string | null
  model?: string | null
  permission_mode: string
  agent?: string | null
  variant?: string | null
  skillNames: string[]
  addDirs: string[]
  json_stream: boolean

  constructor(opts: OpenCodeAgentOptionsOptions = {}) {
    super(opts.workdir ?? undefined, opts.env_vars)
    this.session_id = opts.session_id ?? undefined
    this.resume = opts.resume ?? false
    this.fork_session_id = opts.fork_session_id ?? undefined
    this.model = opts.model ?? undefined
    this.permission_mode = opts.permission_mode ?? 'bypassPermissions'
    this.agent = opts.agent ?? undefined
    this.variant = opts.variant ?? undefined
    this.skillNames = opts.skill_names ?? []
    this.addDirs = opts.add_dirs ?? []
    this.json_stream = opts.json_stream ?? true
  }

  get resolvedModel(): string | undefined {
    return resolveModelTier(OPENCODE_MODEL_TIERS, this.model)
  }

  private _autoEnabled(): boolean {
    return this.permission_mode === 'bypassPermissions'
  }

  /**
   * Flags shared by BOTH shapes. The working directory is deliberately absent —
   * the two shapes spell it differently (see `_buildWorkerArgs`).
   */
  protected _commonTail(): string[] {
    const tail: string[] = []
    if (this.resolvedModel) tail.push(`--model ${shellQuote(this.resolvedModel)}`)
    if (this.agent) tail.push(`--agent ${shellQuote(this.agent)}`)
    // `--variant` is a `run`-only flag; the bare TUI's parser rejects it.
    if (this.variant && this.json_stream) tail.push(`--variant ${shellQuote(this.variant)}`)
    if (this.resume && this.session_id) {
      tail.push(`--session ${shellQuote(this.session_id)}`)
      if (this.fork_session_id) tail.push('--fork')
    }
    return tail
  }

  /**
   * Two shapes keyed on `json_stream`, mirroring `OpenCodeAgentOptions._emit_flags`
   * in `flow_sdk/.../opencode/cli.py`. Measured on opencode 1.18.16: `opencode run`
   * takes `--dir <path>`, but the bare TUI is `opencode [project]` — a POSITIONAL,
   * with no `--dir` flag at all. Handing the TUI `--dir` (or `--variant`) makes
   * yargs dump usage and exit 1, so a command built here would die before the
   * composer ever painted.
   */
  protected _buildWorkerArgs(): string[] {
    const auto = this._autoEnabled() ? ['--auto'] : []
    if (!this.json_stream) {
      const workdir = this.workdir ? [shellQuote(this.workdir)] : []
      return ['opencode', ...auto, ...workdir, ...this._commonTail()]
    }
    const dir = this.workdir ? [`--dir ${shellQuote(this.workdir)}`] : []
    return ['opencode', 'run', '--format', 'json', ...auto, ...dir, ...this._commonTail()]
  }

  toJson(): Record<string, any> {
    return {
      ...super.toJson(),
      worker_type: 'opencode',
      session_id: this.session_id,
      resume: this.resume,
      fork_session_id: this.fork_session_id,
      model: this.model,
      permission_mode: this.permission_mode,
      agent: this.agent,
      variant: this.variant,
      skill_names: this.skillNames,
      add_dirs: this.addDirs,
      json_stream: this.json_stream,
    }
  }

  static fromJson(data: Record<string, any>): OpenCodeAgentOptions {
    return new OpenCodeAgentOptions({
      session_id: data['session_id'] ?? undefined,
      resume: Boolean(data['resume'] ?? false),
      fork_session_id: data['fork_session_id'] ?? undefined,
      model: data['model'] ?? undefined,
      permission_mode: data['permission_mode'] ?? 'bypassPermissions',
      agent: data['agent'] ?? undefined,
      variant: data['variant'] ?? undefined,
      skill_names: data['skill_names'] ?? [],
      workdir: data['workdir'] ?? undefined,
      env_vars: data['env_vars'] ?? {},
      add_dirs: data['add_dirs'] ?? [],
      json_stream: data['json_stream'] !== undefined ? Boolean(data['json_stream']) : true,
    })
  }
}
