import { WorkerCliOptions } from './base'

export interface CodexAgentOptionsOptions {
  session_id?: string | null
  resume?: boolean
  model?: string | null
  permission_mode?: string
  skill_names?: string[]
  workdir?: string
  env_vars?: Record<string, string>
  add_dirs?: string[]
  json_stream?: boolean
  ephemeral?: boolean
}

export class CodexAgentOptions extends WorkerCliOptions {
  session_id?: string | null
  resume: boolean
  model?: string | null
  permission_mode: string
  skillNames: string[]
  addDirs: string[]
  json_stream: boolean
  ephemeral: boolean

  constructor(opts: CodexAgentOptionsOptions = {}) {
    super(opts.workdir ?? undefined, opts.env_vars)
    this.session_id = opts.session_id ?? undefined
    this.resume = opts.resume ?? false
    this.model = opts.model ?? undefined
    this.permission_mode = opts.permission_mode ?? 'bypassPermissions'
    this.skillNames = opts.skill_names ?? []
    this.addDirs = opts.add_dirs ?? []
    this.json_stream = opts.json_stream ?? true
    this.ephemeral = opts.ephemeral ?? true
  }

  toJson(): Record<string, any> {
    return {
      ...super.toJson(),
      worker_type: 'codex',
      session_id: this.session_id,
      resume: this.resume,
      model: this.model,
      permission_mode: this.permission_mode,
      skill_names: this.skillNames,
      add_dirs: this.addDirs,
      json_stream: this.json_stream,
      ephemeral: this.ephemeral,
    }
  }

  static fromJson(data: Record<string, any>): CodexAgentOptions {
    return new CodexAgentOptions({
      session_id: data['session_id'] ?? undefined,
      resume: Boolean(data['resume'] ?? false),
      model: data['model'] ?? undefined,
      permission_mode: data['permission_mode'] ?? 'bypassPermissions',
      skill_names: data['skill_names'] ?? [],
      workdir: data['workdir'] ?? undefined,
      env_vars: data['env_vars'] ?? {},
      add_dirs: data['add_dirs'] ?? [],
      json_stream: data['json_stream'] !== undefined ? Boolean(data['json_stream']) : true,
      ephemeral: data['ephemeral'] !== undefined ? Boolean(data['ephemeral']) : true,
    })
  }
}
