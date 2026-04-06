import type { AgenticProcess } from '../../process/agentic-process';
import type { AgenticContext, PermissionMode } from '../../process/agentic-context';

/**
 * Typed representation of a `claude …` CLI invocation.
 *
 * Provides parse / modify / generate helpers so callers never need to
 * hand-craft CLI strings.  Used by ClaudeSessionManager and
 * SessionInfoPopover (replacing ad-hoc string concatenation).
 */
export class ClaudeCliCommand {
  sessionId?: string; // --session-id
  resume?: string; // --resume  (mutually exclusive with sessionId)
  model?: string; // --model
  permissionMode?: PermissionMode; // maps to --dangerously-skip-permissions
  chrome?: boolean; // --chrome
  debug?: boolean; // --debug
  agentsJson?: Record<string, unknown>; // --agents <json>
  prompt?: string; // -p "…"
  cwd?: string; // cd <cwd> && … (prepended to command)

  // ── Parsing ──────────────────────────────────────────────────────────────

  /**
   * Parse a shell command string (e.g. "cd /foo && claude --chrome --session-id abc")
   * into typed fields.
   */
  static parse(cmdString: string): ClaudeCliCommand {
    const cmd = new ClaudeCliCommand();

    // Strip optional `cd <cwd> &&` prefix
    const cdMatch = cmdString.match(/^cd\s+(.+?)\s*&&\s*/);
    if (cdMatch) {
      cmd.cwd = cdMatch[1].trim();
      cmdString = cmdString.slice(cdMatch[0].length);
    }

    // Tokenise (very simple: split on whitespace, no quoting support needed)
    const parts = cmdString.trim().split(/\s+/);
    let i = 0;

    // Skip leading "claude" token if present
    if (parts[0] === 'claude') i = 1;

    while (i < parts.length) {
      const part = parts[i];
      switch (part) {
        case '--session-id':
          cmd.sessionId = parts[++i];
          break;
        case '--resume':
          cmd.resume = parts[++i];
          break;
        case '--model':
          cmd.model = parts[++i];
          break;
        case '--dangerously-skip-permissions':
          cmd.permissionMode = 'bypassPermissions';
          break;
        case '--chrome':
          cmd.chrome = true;
          break;
        case '--debug':
          cmd.debug = true;
          break;
        case '-p':
          cmd.prompt = parts[++i];
          break;
        case '--agents':
          try {
            cmd.agentsJson = JSON.parse(parts[++i]);
          } catch {
            // ignore malformed json
          }
          break;
        default:
          break;
      }
      i++;
    }

    return cmd;
  }

  // ── Generation ───────────────────────────────────────────────────────────

  /** Generate args array suitable for passing to a subprocess. */
  toArgs(): string[] {
    const args: string[] = [];
    if (this.permissionMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions');
    }
    if (this.chrome) {
      args.push('--chrome');
    }
    if (this.debug) {
      args.push('--debug');
    }
    if (this.resume) {
      args.push('--resume', this.resume);
    } else if (this.sessionId) {
      args.push('--session-id', this.sessionId);
    }
    if (this.model) {
      args.push('--model', this.model);
    }
    if (this.agentsJson) {
      args.push('--agents', JSON.stringify(this.agentsJson));
    }
    if (this.prompt) {
      args.push('-p', this.prompt);
    }
    return args;
  }

  /** Generate a shell-ready command string (for display / PTY injection). */
  toString(): string {
    const cmd = ['claude', ...this.toArgs()].join(' ');
    return this.cwd ? `cd ${this.cwd} && ${cmd}` : cmd;
  }

  // ── Mutation helpers ─────────────────────────────────────────────────────

  /** Return a new ClaudeCliCommand with the given fields overridden. */
  with(patch: Partial<ClaudeCliCommand>): ClaudeCliCommand {
    return Object.assign(new ClaudeCliCommand(), this, patch);
  }

  // ── Factory helpers ──────────────────────────────────────────────────────

  /**
   * Derive a ClaudeCliCommand from an AgenticProcess entity's context_data
   * and session fields.
   */
  static fromProcess(process: AgenticProcess): ClaudeCliCommand {
    const ctx = process.context_data ?? {};
    const cmd = new ClaudeCliCommand();
    cmd.sessionId = process.session_id ?? undefined;
    cmd.model = (ctx.model as string) || undefined;
    cmd.permissionMode = (ctx.permission_mode as PermissionMode) || undefined;
    cmd.chrome = (ctx.chrome as boolean) || undefined;
    cmd.debug = (ctx.debug as boolean) ?? true; // default on
    cmd.cwd = (ctx.workdir as string) || undefined;
    return cmd;
  }

  /**
   * Derive a ClaudeCliCommand from an AgenticContext DTO + session ID.
   *
   * @param ctx       - AgenticContext with settings
   * @param sessionId - Worker session ID
   * @param resume    - If true, use --resume instead of --session-id
   */
  static fromContext(ctx: AgenticContext, sessionId: string, resume = false): ClaudeCliCommand {
    const cmd = new ClaudeCliCommand();
    if (resume) {
      cmd.resume = sessionId;
    } else {
      cmd.sessionId = sessionId;
    }
    cmd.model = ctx.model;
    cmd.permissionMode = ctx.permissionMode;
    cmd.chrome = ctx.chrome;
    cmd.debug = ctx.debug ?? true; // default on
    cmd.cwd = ctx.workdir;
    if (ctx.agentsJson) {
      cmd.agentsJson = ctx.agentsJson as Record<string, unknown>;
    }
    return cmd;
  }
}
