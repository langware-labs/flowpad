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
  ChromeAuthenticated: 'browsing.chrome.authenticated',
  GitHub: 'source_control.git.github',
  GitHubGh: 'source_control.git.github.gh',
} as const;

export type CapabilityKindKey = keyof typeof CapabilityKinds;
export type CapabilityKindValue = (typeof CapabilityKinds)[CapabilityKindKey];

/** The harness leaf kinds an interactive tab can run on, in display order. */
export const HARNESS_CAPABILITY_KINDS: readonly string[] = [
  CapabilityKinds.ClaudeCode,
  CapabilityKinds.Codex,
  CapabilityKinds.Copilot,
];
