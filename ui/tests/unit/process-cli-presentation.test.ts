import {
  buildSessionResumeCommand,
  CODEX_CLI_REFERENCE_URL,
  getWorkerCliCapabilities,
  workerCliVendor,
} from '@src/components/terminal/interactive-terminal/process-cli-presentation';
import { describe, expect, it } from 'vitest';

describe('worker CLI presentation', () => {
  it('exposes only supported Codex launch controls and OpenAI documentation', () => {
    const capabilities = getWorkerCliCapabilities('codex');

    expect(capabilities).toMatchObject({
      vendor: 'codex',
      chrome: false,
      fullTrust: true,
      fullTrustFlag: '--dangerously-bypass-approvals-and-sandbox',
      fullTrustDocsUrl: CODEX_CLI_REFERENCE_URL,
      debug: false,
      worktree: false,
    });
    expect(capabilities.fullTrustDescription?.message).toBe(
      'Skip approvals and sandboxing (--dangerously-bypass-approvals-and-sandbox)',
    );
    expect(capabilities.fullTrustDocsUrl).toContain('developers.openai.com/codex');
    expect(capabilities.fullTrustDocsUrl).not.toContain('anthropic.com');
  });

  it('reproduces the exact pre-vendor-split Claude toolbar surface', () => {
    // The claude row of the capability table IS the pre-fix toolbar contract:
    // Chrome + Debug + Worktree toggles, Anthropic docs, the claude full-trust
    // flag and its description string. Any drift here is a claude regression.
    const capabilities = getWorkerCliCapabilities('claude_code');
    expect(capabilities).toMatchObject({
      vendor: 'claude',
      chrome: true,
      fullTrust: true,
      fullTrustFlag: '--dangerously-skip-permissions',
      fullTrustDocsUrl: 'https://docs.anthropic.com/en/docs/claude-code/settings',
      debug: true,
      worktree: true,
    });
    expect(capabilities.fullTrustDescription?.message).toBe(
      'Skip all permission prompts (--dangerously-skip-permissions)',
    );
    // Bare 'claude' and a missing worker_type (legacy rows) resolve identically.
    expect(getWorkerCliCapabilities('claude')).toEqual(capabilities);
    expect(getWorkerCliCapabilities(null)).toEqual(capabilities);
    expect(workerCliVendor(null)).toBe('claude');
  });

  it('treats unknown workers conservatively (no toggles, no docs)', () => {
    expect(getWorkerCliCapabilities('custom-worker')).toEqual({
      vendor: 'unknown',
      chrome: false,
      fullTrust: false,
      fullTrustFlag: null,
      fullTrustDescription: null,
      fullTrustDocsUrl: null,
      debug: false,
      worktree: false,
    });
  });
});

describe('session resume command', () => {
  it('uses the Codex positional resume form and Codex full-trust flag', () => {
    const command = buildSessionResumeCommand({
      workerType: 'codex',
      sessionId: '019abcde-1234-7000-8000-abcdefabcdef',
      permissionMode: 'bypassPermissions',
      model: 'gpt-5.4',
      chrome: true,
      debug: true,
      worktree: true,
    });

    expect(command).toBe(
      'codex --dangerously-bypass-approvals-and-sandbox -m gpt-5.4 resume 019abcde-1234-7000-8000-abcdefabcdef',
    );
    expect(command).not.toContain('claude');
    expect(command).not.toContain('--resume');
    expect(command).not.toContain('--chrome');
    expect(command).not.toContain('--debug');
    expect(command).not.toContain('--worktree');
  });

  it('omits the Codex bypass flag outside full-trust mode and quotes values', () => {
    expect(
      buildSessionResumeCommand({
        workerType: 'codex',
        sessionId: 'named session',
        permissionMode: 'askUser',
        model: 'model preview',
      }),
    ).toBe("codex -m 'model preview' resume 'named session'");
  });

  it('keeps Claude resume syntax unchanged', () => {
    expect(
      buildSessionResumeCommand({
        workerType: 'claude_code',
        sessionId: 'claude-session',
        permissionMode: 'bypassPermissions',
        chrome: true,
        debug: true,
        worktree: true,
        model: 'sonnet',
      }),
    ).toBe('claude --dangerously-skip-permissions --chrome --debug --worktree --resume claude-session --model sonnet');
  });
});
