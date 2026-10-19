import { WorkerCliOptions } from './base'

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
