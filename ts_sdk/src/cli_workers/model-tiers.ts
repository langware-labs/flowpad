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

export function resolveModelTier(
  tierMap: Record<string, string | null>,
  model?: string | null,
): string | undefined {
  if (!model) return undefined
  return Object.prototype.hasOwnProperty.call(tierMap, model) ? (tierMap[model] ?? undefined) : model
}
