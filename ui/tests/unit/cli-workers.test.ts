import { describe, it, expect } from 'vitest';
import {
  ClaudeAgentOptions,
  CodexAgentOptions,
  CopilotAgentOptions,
  OpenCodeAgentOptions,
  AgenticProcess,
  factory,
  shellQuote,
} from '@sdk';

// The client carries a worker's persisted CLI configuration and hands it back
// verbatim; the BACKEND builds the actual command line. The vendor argv shapes
// (opencode's positional TUI dir, no --add-dir, --session only on resume, the
// model-tier aliases) are asserted where they are implemented, in
// tests/unit/test_{claude,codex,copilot,opencode}_cli_cmd.py.

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
};

describe('shellQuote', () => {
  it('safe chars pass through unquoted', () => {
    expect(shellQuote('/simple/path')).toBe('/simple/path');
  });

  it('a space forces single quotes', () => {
    expect(shellQuote('/my project')).toBe("'/my project'");
  });

  it("a single quote becomes '\\''", () => {
    expect(shellQuote("/proj/it's")).toBe("'/proj/it'\\''s'");
  });

  it('empty string becomes two quotes', () => {
    expect(shellQuote('')).toBe("''");
  });
});

describe('WorkerCliOptions base structure', () => {
  it('carries workdir and env vars into toJson', () => {
    const cmd = new ClaudeAgentOptions({ workdir: '/proj' });
    cmd.addEnv('KEY', 'val');
    const json = cmd.toJson();
    expect(json.workdir).toBe('/proj');
    expect(json.env_vars.KEY).toBe('val');
  });
});

describe('ClaudeAgentOptions', () => {
  it('auto-injects CLAUDE_PROJECT_DIR from workdir', () => {
    const cmd = new ClaudeAgentOptions({ workdir: '/proj' });
    expect(cmd.envVars['CLAUDE_PROJECT_DIR']).toBe('/proj');
  });

  it('does not overwrite explicit CLAUDE_PROJECT_DIR', () => {
    const cmd = new ClaudeAgentOptions({
      workdir: '/proj',
      env_vars: { CLAUDE_PROJECT_DIR: '/override' },
    });
    expect(cmd.envVars['CLAUDE_PROJECT_DIR']).toBe('/override');
  });

  it('persists the model tier raw — resolution is the backend’s job', () => {
    const cmd = new ClaudeAgentOptions({ model: 'sm', workdir: '/proj' });
    expect(cmd.model).toBe('sm');
    expect(cmd.toJson().model).toBe('sm');
  });

  it('debug defaults on and survives an explicit false', () => {
    expect(new ClaudeAgentOptions({ workdir: '/proj' }).toJson().debug).toBe(true);
    expect(new ClaudeAgentOptions({ workdir: '/proj', debug: false }).toJson().debug).toBe(false);
  });

  it('round-trips toJson → fromJson byte-for-byte', () => {
    const cmd = new ClaudeAgentOptions({
      session_id: 'abc',
      resume: true,
      fork_session_id: 'src-uuid',
      debug: false,
      workdir: '/proj',
    });
    const cmd2 = ClaudeAgentOptions.fromJson(cmd.toJson());
    expect(cmd2.toJson()).toEqual(cmd.toJson());
  });
});

describe('factory()', () => {
  it.each([
    ['claude', ClaudeAgentOptions],
    ['codex', CodexAgentOptions],
    ['copilot', CopilotAgentOptions],
    ['opencode', OpenCodeAgentOptions],
  ])('returns the %s options class', (workerType, cls) => {
    const cmd = factory({ worker_type: workerType, workdir: '/proj' }, workerType);
    expect(cmd).toBeInstanceOf(cls);
    expect(cmd.toJson().worker_type).toBe(workerType);
  });

  it('maps the claude_code alias onto claude', () => {
    expect(factory({ workdir: '/proj' }, 'claude_code')).toBeInstanceOf(ClaudeAgentOptions);
  });

  it.each(['sm', 'md', 'lg'])('persists the portable tier %s untouched', (tier) => {
    for (const wt of ['codex', 'copilot', 'opencode']) {
      expect(factory({ worker_type: wt, model: tier, workdir: '/proj' }, wt).toJson().model).toBe(tier);
    }
  });

  it('throws for unknown worker_type', () => {
    expect(() => factory({}, 'unknown')).toThrow('Unknown worker_type');
  });
});

describe('proc.cliOptions — frontend override of server cli_config', () => {
  it('deserializes server config, then local overrides win in toJson', () => {
    const cliOptions = factory(BACKEND_CLI_CONFIG, 'claude') as ClaudeAgentOptions;
    cliOptions.debug = false;
    cliOptions.addEnv('ENV_KEY', 'ENV_VAL');

    const json = cliOptions.toJson();
    expect(json.debug).toBe(false);
    expect(json.env_vars.SOME_SERVER_VAR).toBe('server_value');
    expect(json.env_vars.ENV_KEY).toBe('ENV_VAL');
    expect(json.session_id).toBe('7a63c18b-1111-2222-3333-444444444444');
    expect(json.resume).toBe(true);
  });

  it('server CLAUDE_PROJECT_DIR is preserved from workdir auto-inject', () => {
    const cliOptions = factory(BACKEND_CLI_CONFIG, 'claude') as ClaudeAgentOptions;
    expect(cliOptions.envVars['CLAUDE_PROJECT_DIR']).toBe('/home/user/myproject');
  });

  it('cliOptions uses the entity workdir when cli_config omits it', () => {
    // cli_config as stored by the backend has no workdir; it lives on the entity
    const proc = Object.assign(new AgenticProcess({}), {
      cli_config: { worker_type: 'claude', resume: true },
      worker_session_id: '7a63c18b-1111-2222-3333-444444444444',
      workdir: '/home/user/myproject',
    });
    expect(proc.cliOptions.toJson().workdir).toBe('/home/user/myproject');
  });

  it('cliOptions picks the worker-specific options class', () => {
    const proc = Object.assign(new AgenticProcess({}), {
      worker_type: 'codex',
      cli_config: { worker_type: 'codex', model: 'sm' },
      workdir: '/home/user/myproject',
    });
    expect(proc.cliOptions).toBeInstanceOf(CodexAgentOptions);
    expect(proc.cliOptions.toJson().model).toBe('sm');
  });
});
