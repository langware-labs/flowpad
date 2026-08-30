import { WorkerCliOptions } from './base'

export interface CopilotAgentOptionsOptions {
  session_id?: string | null
  resume?: boolean
  model?: string | null
  permission_mode?: string
  effort?: string | null
  skill_names?: string[]
  workdir?: string
  env_vars?: Record<string, string>
  add_dirs?: string[]
  json_stream?: boolean
  no_ask_user?: boolean
  no_auto_update?: boolean
  no_custom_instructions?: boolean
  allow_all?: boolean
}

export class CopilotAgentOptions extends WorkerCliOptions {
  session_id?: string | null
  resume: boolean
  model?: string | null
  permission_mode: string
  effort?: string | null
  skillNames: string[]
  addDirs: string[]
  json_stream: boolean
  no_ask_user: boolean
  no_auto_update: boolean
  no_custom_instructions: boolean
  allow_all: boolean

  constructor(opts: CopilotAgentOptionsOptions = {}) {
    super(opts.workdir ?? undefined, opts.env_vars)
    this.session_id = opts.session_id ?? undefined
    this.resume = opts.resume ?? false
    this.model = opts.model ?? undefined
    this.permission_mode = opts.permission_mode ?? 'bypassPermissions'
    this.effort = opts.effort ?? undefined
    this.skillNames = opts.skill_names ?? []
    this.addDirs = opts.add_dirs ?? []
    this.json_stream = opts.json_stream ?? true
    this.no_ask_user = opts.no_ask_user ?? true
    this.no_auto_update = opts.no_auto_update ?? true
    this.no_custom_instructions = opts.no_custom_instructions ?? true
    this.allow_all = opts.allow_all ?? true
  }




  toJson(): Record<string, any> {
    return {
      ...super.toJson(),
      worker_type: 'copilot',
      session_id: this.session_id,
      resume: this.resume,
      model: this.model,
      permission_mode: this.permission_mode,
      effort: this.effort,
      skill_names: this.skillNames,
      add_dirs: this.addDirs,
      json_stream: this.json_stream,
      no_ask_user: this.no_ask_user,
      no_auto_update: this.no_auto_update,
      no_custom_instructions: this.no_custom_instructions,
      allow_all: this.allow_all,
    }
  }

  static fromJson(data: Record<string, any>): CopilotAgentOptions {
    return new CopilotAgentOptions({
      session_id: data['session_id'] ?? undefined,
      resume: Boolean(data['resume'] ?? false),
      model: data['model'] ?? undefined,
      permission_mode: data['permission_mode'] ?? 'bypassPermissions',
      effort: data['effort'] ?? undefined,
      skill_names: data['skill_names'] ?? [],
      workdir: data['workdir'] ?? undefined,
      env_vars: data['env_vars'] ?? {},
      add_dirs: data['add_dirs'] ?? [],
      json_stream: data['json_stream'] !== undefined ? Boolean(data['json_stream']) : true,
      no_ask_user: data['no_ask_user'] !== undefined ? Boolean(data['no_ask_user']) : true,
      no_auto_update: data['no_auto_update'] !== undefined ? Boolean(data['no_auto_update']) : true,
      no_custom_instructions: data['no_custom_instructions'] !== undefined ? Boolean(data['no_custom_instructions']) : true,
      allow_all: data['allow_all'] !== undefined ? Boolean(data['allow_all']) : true,
    })
  }
}
