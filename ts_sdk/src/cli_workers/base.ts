/**
 * WorkerCliOptions — the client-side carrier for a worker's persisted CLI
 * configuration.
 *
 * Mirrors the field set of Python `flow_sdk/builtin/cli_workers/base.py`. This
 * class only holds and serializes those fields (`toJson`/`fromJson`); the
 * backend is the sole authority for turning them into an actual command line,
 * so no argv or shell-string building happens here.
 */
export abstract class WorkerCliOptions {
  workdir?: string
  envVars: Record<string, string>

  constructor(workdir?: string, envVars?: Record<string, string>) {
    this.workdir = workdir
    this.envVars = { ...(envVars ?? {}) }
  }

  addEnv(key: string, value: string): void {
    this.envVars[key] = value
  }

  toJson(): Record<string, any> {
    return { workdir: this.workdir, env_vars: this.envVars }
  }
}
