/**
 * WorkerCliOptions — cross-platform base for building shell command strings.
 *
 * Mirrors Python flow_sdk/builtin/cli_workers/base.py exactly.
 * Subclasses implement _buildWorkerArgs() to produce the executable + its flags.
 * The base handles workdir (cd prefix), env vars prefix, and instruction injection.
 */

/**
 * Shell-quote a string — matches Python shlex.quote exactly.
 * - empty string → "''"
 * - safe chars only (word chars + @%+=:,./-) → return as-is
 * - otherwise → wrap in single-quotes, escape ' → '\''
 */
export function shellQuote(s: string): string {
  if (!s) return "''"
  if (!/[^\w@%+=:,.\/-]/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

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

  /** Build the full shell command string. POSIX only — browser always talks to Linux/Mac server. */
  toShellString(instruction?: string): string {
    const args = this._buildWorkerArgs()
    const wd = this.workdir ?? '.'
    const cdPart = `cd ${shellQuote(wd)}`
    const envEntries = Object.entries(this.envVars)
    const envPart = envEntries.map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ')
    let cmd = envPart
      ? `${cdPart} && ${envPart} ${args.join(' ')}`
      : `${cdPart} && ${args.join(' ')}`
    if (instruction) {
      if (instruction.includes('\n')) {
        cmd += ` "$(cat <<'EOF'\n${instruction}\nEOF\n)"`
      } else {
        cmd += ` ${shellQuote(instruction)}`
      }
    }
    return cmd
  }

  toJson(): Record<string, any> {
    return { workdir: this.workdir, env_vars: this.envVars }
  }

  protected abstract _buildWorkerArgs(): string[]
}
