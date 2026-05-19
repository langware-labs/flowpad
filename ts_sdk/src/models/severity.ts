/**
 * Severity tier — single source of truth across the workflow-runner UI.
 *
 * Analyzers have drifted across cycles (we observed at least three vocabularies:
 * `blocker/derived/info`, `error/warn/info`, `high/medium/low`). Every consumer
 * used to reinvent normalization. This tier collapses all of them into three
 * buckets, modeled on Sentry's Issue Priority (High/Medium/Low).
 *
 * UI rules per tier:
 *   ATTENTION — pinned banner + red gutter chip; visible in simple + expert
 *   NOTABLE   — soft yellow gutter chip; visible in simple + expert
 *   INFO      — gray gutter chip; HIDDEN in simple mode, shown only in expert
 */
export enum SeverityTier {
  ATTENTION = 'attention',
  NOTABLE = 'notable',
  INFO = 'info',
}

const ATTENTION_TOKENS = new Set([
  'attention',
  'error',
  'blocker',
  'critical',
  'fatal',
  'high',
  'sut_regression',
  'regression',
  'sla_violation',
  'status_mismatch',
]);

const NOTABLE_TOKENS = new Set([
  'notable',
  'warn',
  'warning',
  'medium',
  'retry',
  'wrong_tool',
  'mid_run_toolsearch',
  'incomplete',
  'protocol_violation',
  'visibility_check',
  'visibility_heuristic_override',
]);

const INFO_TOKENS = new Set([
  'info',
  'low',
  'derived',
  'observation',
  'behavior',
  'latency',
]);

/**
 * Classify an analyzer issue into a tier.
 *
 * Accepts whatever fields the analyzer produced — `severity`, `kind`,
 * `category`, or no signal at all. Order of precedence is severity → kind →
 * category. Unknown tokens default to NOTABLE so the user still sees them
 * in simple mode (better to over-show once than to lose a real issue).
 *
 * @example
 *   classifySeverity('error') === SeverityTier.ATTENTION
 *   classifySeverity('high', 'sut_regression') === SeverityTier.ATTENTION
 *   classifySeverity(undefined, 'wrong_tool') === SeverityTier.NOTABLE
 *   classifySeverity('info') === SeverityTier.INFO
 *   classifySeverity() === SeverityTier.NOTABLE  // unknown ≠ silent
 */
export function classifySeverity(
  rawSeverity?: string | null,
  rawKind?: string | null,
  rawCategory?: string | null,
): SeverityTier {
  for (const raw of [rawSeverity, rawKind, rawCategory]) {
    if (!raw) continue;
    const token = String(raw).trim().toLowerCase();
    if (!token) continue;
    if (ATTENTION_TOKENS.has(token)) return SeverityTier.ATTENTION;
    if (NOTABLE_TOKENS.has(token)) return SeverityTier.NOTABLE;
    if (INFO_TOKENS.has(token)) return SeverityTier.INFO;
  }
  return SeverityTier.NOTABLE;
}

/** Tier ordering for sort. Higher number = more urgent. */
export const SEVERITY_RANK: Record<SeverityTier, number> = {
  [SeverityTier.ATTENTION]: 2,
  [SeverityTier.NOTABLE]: 1,
  [SeverityTier.INFO]: 0,
};

/** Whether a tier is visible in simple mode. */
export function isVisibleInSimpleMode(tier: SeverityTier): boolean {
  return tier !== SeverityTier.INFO;
}
