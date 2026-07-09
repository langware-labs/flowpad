/**
 * Build a `GraphContext.context_typeids` list from an identity typeid plus any
 * widening typeids, dropping the ones that aren't present. Every context-process
 * surface (per-message, per-analysis, diagnose, …) declares its context this way,
 * so the guarded-push boilerplate lives here once.
 */
export function compactTypeIds(
  ...ids: Array<string | null | undefined | false>
): string[] {
  return ids.filter((x): x is string => !!x);
}
