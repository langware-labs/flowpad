import { WorkerCliOptions, shellQuote } from './base'
import { CODEX_MODEL_TIERS, resolveModelTier } from './model-tiers'

export interface CodexCliOptionsOptions {
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

export class CodexCliOptions extends WorkerCliOptions {
  session_id?: string | null
  resume: boolean
  model?: string | null
  permission_mode: string
  skillNames: string[]
  addDirs: string[]
  json_stream: boolean
  ephemeral: boolean

  static DEFAULT_REASONING_EFFORT = 'low'

  constructor(opts: CodexCliOptionsOptions = {}) {
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

  get resolvedModel(): string | undefined {
    return resolveModelTier(CODEX_MODEL_TIERS, this.model)
  }

  protected _commonTail(): string[] {
    const tail: string[] = []
    if (this.workdir) tail.push(`-C ${shellQuote(this.workdir)}`)
    if (this.resolvedModel) tail.push(`-m ${shellQuote(this.resolvedModel)}`)
    for (const d of this.addDirs) tail.push(`--add-dir ${shellQuote(d)}`)
    if (this.resume && this.session_id) tail.push(`resume ${shellQuote(this.session_id)}`)
    return tail
  }

  protected _buildWorkerArgs(): string[] {
    const bypass = this.permission_mode === 'bypassPermissions'
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : []
    if (!this.json_stream) return ['codex', ...bypass, ...this._commonTail()]

    const head = ['codex', 'exec', '--skip-git-repo-check', ...bypass]
    if (this.ephemeral) head.push('--ephemeral')
    head.push('--json')
    head.push('-c', `model_reasoning_effort=${CodexCliOptions.DEFAULT_REASONING_EFFORT}`)
    return [...head, ...this._commonTail(), '-']
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

  static fromJson(data: Record<string, any>): CodexCliOptions {
    return new CodexCliOptions({
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
