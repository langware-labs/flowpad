export * from './CapabilityManager';

/**
 * Well-known capability kind keys (mirror the backend
 * `flow_sdk/core/capabilities` ontology). Use these instead of raw strings
 * when querying `useCapability` / `capabilityManager`.
 */
export const CapabilityKinds = {
  /** CapabilityReference row — resolves to the selected default harness. */
  Harness: 'harness',
  ClaudeCode: 'harness.claude.cli',
  Codex: 'harness.codex.cli',
  Copilot: 'harness.copilot.cli',
  OpenCode: 'harness.opencode.cli',
  ChromeAuthenticated: 'browsing.chrome.authenticated',
  GitHub: 'source_control.git.github',
  GitHubGh: 'source_control.git.github.gh',
} as const;

export type CapabilityKindKey = keyof typeof CapabilityKinds;
export type CapabilityKindValue = (typeof CapabilityKinds)[CapabilityKindKey];

/**
 * ``AgenticProcess.worker_type`` → the harness capability that provides its CLI.
 * The mirror of `flow_sdk/core/capabilities/mcp.py::_WORKER_TYPE_TO_HARNESS` —
 * the two tokens are NOT the same word (claude registers `worker_type
 * "claude_code"` against kind `harness.claude.cli`), so this must be a lookup
 * and never string interpolation. `null` for a worker type with no harness.
 */
const WORKER_TYPE_TO_HARNESS_KIND: Readonly<Record<string, string>> = {
  claude: CapabilityKinds.ClaudeCode,
  claude_code: CapabilityKinds.ClaudeCode,
  claude_code_cli: CapabilityKinds.ClaudeCode,
  unsecured_claude: CapabilityKinds.ClaudeCode,
  codex: CapabilityKinds.Codex,
  copilot: CapabilityKinds.Copilot,
  opencode: CapabilityKinds.OpenCode,
};

/** The harness capability kind a worker type runs on, or `null` if none does. */
export function harnessKindForWorkerType(workerType: string | null | undefined): string | null {
  return WORKER_TYPE_TO_HARNESS_KIND[(workerType ?? '').trim().toLowerCase()] ?? null;
}

/** The harness leaf kinds an interactive tab can run on, in display order. */
export const HARNESS_CAPABILITY_KINDS: readonly string[] = [
  CapabilityKinds.ClaudeCode,
  CapabilityKinds.Codex,
  CapabilityKinds.Copilot,
  CapabilityKinds.OpenCode,
];
