import { describe, it, expect } from 'vitest'
import { ClaudeAgentOptions, CodexAgentOptions, CopilotAgentOptions, AgenticProcess, factory } from '@sdk'

// Simulates what the backend serializes into proc.cli_config
const BACKEND_CLI_CONFIG = {
  worker_type: 'claude',
  session_id: '7a63c18b-1111-2222-3333-444444444444',
  resume: true,
  fork_session_id: null,
  model: null,
  debug: true,
  permission_mode: 'bypassPermissions',
  chrome: false,
  worktree: false,
  agents_json: null,
  workdir: '/home/user/myproject',
  env_vars: { SOME_SERVER_VAR: 'server_value' },
}

describe('shellQuote (via toShellString output)', () => {
  it('safe path — no quotes', () => {
    const cmd = new ClaudeAgentOptions({ workdir: '/simple/path' })
    expect(cmd.toShellString()).toContain('cd /simple/path')
  })

  it('path with space — single-quoted', () => {
    const cmd = new ClaudeAgentOptions({ workdir: '/my project' })
    expect(cmd.toShellString()).toContain("cd '/my project'")
  })

  it("path with single-quote — '\\''  escape", () => {
    const cmd = new ClaudeAgentOptions({ workdir: "/proj/it's" })
    expect(cmd.toShellString()).toContain("cd '/proj/it'\\''s'")
  })
})

describe('WorkerCliOptions base structure', () => {
  it('produces cd && env && args format', () => {
    const cmd = new ClaudeAgentOptions({ workdir: '/proj' })
    // CLAUDE_PROJECT_DIR is always auto-injected from workdir
    expect(cmd.toShellString()).toMatch(/^cd \/proj && CLAUDE_PROJECT_DIR=\/proj claude/)
  })

  it('env vars appear between cd and args', () => {
    const cmd = new ClaudeAgentOptions({ workdir: '/proj' })
    cmd.addEnv('KEY', 'val')
    const out = cmd.toShellString()
    const cdIdx = out.indexOf('cd ')
    const keyIdx = out.indexOf('KEY=')
    const claudeIdx = out.indexOf('claude')
    expect(cdIdx).toBeLessThan(keyIdx)
    expect(keyIdx).toBeLessThan(claudeIdx)
  })

  it('single-line instruction appended quoted', () => {
    const cmd = new ClaudeAgentOptions({ workdir: '/proj' })
    expect(cmd.toShellString('fix the bug')).toContain("'fix the bug'")
  })

  it('multi-line instruction as heredoc', () => {
    const cmd = new ClaudeAgentOptions({ workdir: '/proj' })
    const out = cmd.toShellString('line1\nline2')
    expect(out).toContain("$(cat <<'EOF'")
    expect(out).toContain('line1\nline2')
  })
})

describe('ClaudeAgentOptions', () => {
  it('auto-injects CLAUDE_PROJECT_DIR from workdir', () => {
    const cmd = new ClaudeAgentOptions({ workdir: '/proj' })
    expect(cmd.envVars['CLAUDE_PROJECT_DIR']).toBe('/proj')
  })

  it('does not overwrite explicit CLAUDE_PROJECT_DIR', () => {
    const cmd = new ClaudeAgentOptions({
      workdir: '/proj',
      env_vars: { CLAUDE_PROJECT_DIR: '/override' },
    })
    expect(cmd.envVars['CLAUDE_PROJECT_DIR']).toBe('/override')
  })

  it('resume=true + session_id → --resume <id>', () => {
    const cmd = new ClaudeAgentOptions({ session_id: 'abc-123', resume: true, workdir: '/proj' })
    // abc-123 is safe chars — no shell quoting needed
    expect(cmd.toShellString()).toContain('--resume abc-123')
  })

  it('resume=false + session_id → --session-id <id>, no --resume', () => {
    const cmd = new ClaudeAgentOptions({ session_id: 'abc-123', resume: false, workdir: '/proj' })
    const out = cmd.toShellString()
    expect(out).toContain('--session-id abc-123')
    expect(out).not.toContain('--resume')
  })

  it('persists model tiers raw but emits Claude model aliases', () => {
    const cmd = new ClaudeAgentOptions({ model: 'sm', workdir: '/proj' })
    expect(cmd.model).toBe('sm')
    expect(cmd.toJson().model).toBe('sm')
    expect(cmd.toShellString()).toContain('--model haiku')
  })

  it('debug=false → no --debug flag', () => {
    const cmd = new ClaudeAgentOptions({ workdir: '/proj', debug: false })
    expect(cmd.toShellString()).not.toContain('--debug')
  })

  it('debug=true (default) → --debug flag present', () => {
    const cmd = new ClaudeAgentOptions({ workdir: '/proj' })
    expect(cmd.toShellString()).toContain('--debug')
  })

  it('fork: --resume <src> --fork-session --session-id <new>', () => {
    const cmd = new ClaudeAgentOptions({
      session_id: 'new-uuid',
      resume: true,
      fork_session_id: 'src-uuid',
      workdir: '/proj',
    })
    const out = cmd.toShellString()
    expect(out).toContain('--resume new-uuid')
    expect(out).toContain('--fork-session')
    expect(out).toContain('--session-id src-uuid')
  })

  it('round-trip: toJson → fromJson → toShellString matches', () => {
    const cmd = new ClaudeAgentOptions({ session_id: 'abc', resume: true, debug: false, workdir: '/proj' })
    const cmd2 = ClaudeAgentOptions.fromJson(cmd.toJson())
    expect(cmd2.toShellString()).toBe(cmd.toShellString())
  })
})

describe('factory()', () => {
  it('returns ClaudeAgentOptions instance for worker_type: claude', () => {
    const cmd = factory({ worker_type: 'claude', workdir: '/proj' }, 'claude')
    expect(cmd).toBeInstanceOf(ClaudeAgentOptions)
  })

  it('returns CodexAgentOptions and resolves portable tiers for codex', () => {
    const cmd = factory({ worker_type: 'codex', model: 'sm', workdir: '/proj' }, 'codex')
    expect(cmd).toBeInstanceOf(CodexAgentOptions)
    expect(cmd.toJson().model).toBe('sm')
    expect(cmd.toShellString()).toContain('-m gpt-5.4-mini')
  })

  it('returns CopilotAgentOptions and resolves portable tiers for copilot', () => {
    const cmd = factory({ worker_type: 'copilot', model: 'lg', workdir: '/proj' }, 'copilot')
    expect(cmd).toBeInstanceOf(CopilotAgentOptions)
    expect(cmd.toJson().model).toBe('lg')
    expect(cmd.toShellString()).toContain('--model gpt-5.5')
  })

  it('throws for unknown worker_type', () => {
    expect(() => factory({}, 'unknown')).toThrow('Unknown worker_type')
  })
})

describe('proc.cliOptions — frontend override of server cli_config', () => {
  it('deserializes server config then overrides debug + env', () => {
    const cliOptions = factory(BACKEND_CLI_CONFIG, 'claude') as ClaudeAgentOptions

    cliOptions.debug = false
    cliOptions.addEnv('ENV_KEY', 'ENV_VAL')

    const out = cliOptions.toShellString()

    expect(out).toContain('SOME_SERVER_VAR=server_value')
    expect(out).not.toContain('--debug')
    expect(out).toContain('ENV_KEY=ENV_VAL')
    expect(out).toContain('--resume 7a63c18b-1111-2222-3333-444444444444')
  })

  it('server CLAUDE_PROJECT_DIR is preserved from workdir auto-inject', () => {
    const cliOptions = factory(BACKEND_CLI_CONFIG, 'claude') as ClaudeAgentOptions
    expect(cliOptions.envVars['CLAUDE_PROJECT_DIR']).toBe('/home/user/myproject')
  })

  it('shell.sendInput flow — toShellString + newline is valid PTY input', () => {
    const cliOptions = factory(BACKEND_CLI_CONFIG, 'claude') as ClaudeAgentOptions
    const inputToShell = cliOptions.toShellString() + '\n'
    expect(inputToShell.endsWith('\n')).toBe(true)
    expect(inputToShell).toContain('claude')
    expect(inputToShell).toContain('--resume')
  })

  it('cliOptions uses entity workdir, not cd . — the fromClaudeSession case', () => {
    // Simulate: cli_config has no workdir (as stored by backend), workdir is on entity
    const proc = Object.assign(new AgenticProcess({}), {
      cli_config: { worker_type: 'claude', resume: true },
      worker_session_id: '7a63c18b-1111-2222-3333-444444444444',
      workdir: '/home/user/myproject',
    })
    expect(proc.cliOptions.toShellString()).toMatch(/^cd \/home\/user\/myproject/)
    expect(proc.cliOptions.toShellString()).not.toContain('cd .')
  })

  it('cliOptions uses worker-specific tier resolution for non-Claude processes', () => {
    const proc = Object.assign(new AgenticProcess({}), {
      worker_type: 'codex',
      cli_config: { worker_type: 'codex', model: 'sm' },
      workdir: '/home/user/myproject',
    })

    expect(proc.cliOptions.toJson().model).toBe('sm')
    expect(proc.cliOptions.toShellString()).toContain('-m gpt-5.4-mini')
    expect(proc.cliOptions.toShellString()).not.toContain('--model haiku')
  })
})
