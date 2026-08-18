export const CLAUDE_MODEL_TIERS: Record<string, string> = {
  sm: 'haiku',
  md: 'sonnet',
  lg: 'opus',
}

export const CODEX_MODEL_TIERS: Record<string, string> = {
  sm: 'gpt-5.4-mini',
  md: 'gpt-5.4',
  lg: 'gpt-5.5',
}

export const COPILOT_MODEL_TIERS: Record<string, string | null> = {
  sm: null,
  md: null,
  lg: null,
}

// OpenCode is provider-agnostic: every id carries its provider prefix, and
// these tiers pick open-weight models through OpenRouter (which opencode
// resolves from a bare OPENROUTER_API_KEY, with no config file at all).
export const OPENCODE_MODEL_TIERS: Record<string, string> = {
  sm: 'openrouter/z-ai/glm-4.7-flash',
  md: 'openrouter/z-ai/glm-5.2',
  lg: 'openrouter/z-ai/glm-5.2',
}

export function resolveModelTier(
  tierMap: Record<string, string | null>,
  model?: string | null,
): string | undefined {
  if (!model) return undefined
  return Object.prototype.hasOwnProperty.call(tierMap, model) ? (tierMap[model] ?? undefined) : model
}
