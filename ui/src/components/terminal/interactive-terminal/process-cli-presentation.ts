import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { shellQuote } from '@sdk';

export const CODEX_CLI_REFERENCE_URL = 'https://developers.openai.com/codex/cli/reference#global-flags';

export const OPENCODE_CLI_REFERENCE_URL = 'https://opencode.ai/docs/cli';

export type WorkerCliVendor = 'claude' | 'codex' | 'copilot' | 'opencode' | 'unknown';

export interface WorkerCliCapabilities {
  vendor: WorkerCliVendor;
  chrome: boolean;
  fullTrust: boolean;
  fullTrustFlag: string | null;
  /** Lazy lingui descriptor — render via `i18n._(...)`. Null ⇔ fullTrust is false. */
  fullTrustDescription: MessageDescriptor | null;
  fullTrustDocsUrl: string | null;
  debug: boolean;
  worktree: boolean;
}

export function workerCliVendor(workerType: string | null | undefined): WorkerCliVendor {
  const normalized = (workerType ?? 'claude').toLowerCase();
  if (normalized === 'codex') return 'codex';
  if (normalized === 'copilot') return 'copilot';
  if (normalized === 'opencode') return 'opencode';
  if (normalized === 'claude' || normalized.startsWith('claude_')) return 'claude';
  return 'unknown';
}

export function getWorkerCliCapabilities(workerType: string | null | undefined): WorkerCliCapabilities {
  const vendor = workerCliVendor(workerType);
  if (vendor === 'codex') {
    return {
      vendor,
      chrome: false,
      fullTrust: true,
      fullTrustFlag: '--dangerously-bypass-approvals-and-sandbox',
      fullTrustDescription: msg`Skip approvals and sandboxing (--dangerously-bypass-approvals-and-sandbox)`,
      fullTrustDocsUrl: CODEX_CLI_REFERENCE_URL,
      debug: false,
      worktree: false,
    };
  }
  if (vendor === 'copilot') {
    return {
      vendor,
      chrome: false,
      fullTrust: true,
      fullTrustFlag: '--allow-all',
      fullTrustDescription: msg`Allow all tools without confirmation (--allow-all)`,
      fullTrustDocsUrl: null,
      debug: false,
      worktree: false,
    };
  }
  if (vendor === 'opencode') {
    // OpenCode's bypass-permissions equivalent is `--auto`. Without this branch
    // it fell through to the `unknown` default, which reports `fullTrust: false`
    // — so the Full Trust toggle silently disappeared for a harness that does
    // support it. It genuinely has no chrome/debug/worktree flags: the bare TUI
    // rejects anything beyond `--model/--agent/--auto/--session/--fork`.
    return {
      vendor,
      chrome: false,
      fullTrust: true,
      fullTrustFlag: '--auto',
      fullTrustDescription: msg`Auto-approve permissions that are not explicitly denied (--auto)`,
      fullTrustDocsUrl: OPENCODE_CLI_REFERENCE_URL,
      debug: false,
      worktree: false,
    };
  }
  if (vendor === 'claude') {
    return {
      vendor,
      chrome: true,
      fullTrust: true,
      fullTrustFlag: '--dangerously-skip-permissions',
      fullTrustDescription: msg`Skip all permission prompts (--dangerously-skip-permissions)`,
      fullTrustDocsUrl: 'https://docs.anthropic.com/en/docs/claude-code/settings',
      debug: true,
      worktree: true,
    };
  }
  return {
    vendor,
    chrome: false,
    fullTrust: false,
    fullTrustFlag: null,
    fullTrustDescription: null,
    fullTrustDocsUrl: null,
    debug: false,
    worktree: false,
  };
}

export interface ResumeCommandOptions {
  workerType: string | null | undefined;
  sessionId: string | null | undefined;
  permissionMode?: string | null;
  chrome?: boolean;
  debug?: boolean;
  worktree?: boolean;
  model?: string | null;
}

/** Build the vendor command run by the Session Info "open terminal" action. */
export function buildSessionResumeCommand({
  workerType,
  sessionId,
  permissionMode,
  chrome,
  debug,
  worktree,
  model,
}: ResumeCommandOptions): string | null {
  const vendor = workerCliVendor(workerType);
  const session = shellQuote(sessionId || '?');
  const selectedModel = model ? shellQuote(model) : null;

  if (vendor === 'codex') {
    const parts = ['codex'];
    if (permissionMode === 'bypassPermissions') {
      parts.push('--dangerously-bypass-approvals-and-sandbox');
    }
    if (selectedModel) parts.push('-m', selectedModel);
    parts.push('resume', session);
    return parts.join(' ');
  }

  if (vendor === 'copilot') {
    const parts = ['copilot'];
    if (permissionMode === 'bypassPermissions') parts.push('--allow-all');
    if (selectedModel) parts.push('--model', selectedModel);
    parts.push(`--resume=${session}`);
    return parts.join(' ');
  }

  if (vendor === 'opencode') {
    // Mirrors `OpenCodeAgentOptions._emit_flags` for the INTERACTIVE shape: the
    // bare TUI takes its directory as a positional and rejects `--dir`, and
    // `--session` only continues an existing session.
    const parts = ['opencode'];
    if (permissionMode === 'bypassPermissions') parts.push('--auto');
    if (selectedModel) parts.push('--model', selectedModel);
    parts.push('--session', session);
    return parts.join(' ');
  }

  if (vendor === 'claude') {
    const parts = ['claude'];
    if (permissionMode === 'bypassPermissions') parts.push('--dangerously-skip-permissions');
    if (chrome) parts.push('--chrome');
    if (debug) parts.push('--debug');
    if (worktree) parts.push('--worktree');
    parts.push('--resume', session);
    if (selectedModel) parts.push('--model', selectedModel);
    return parts.join(' ');
  }

  return null;
}
