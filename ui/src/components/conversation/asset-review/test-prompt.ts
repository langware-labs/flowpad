/** Entity types the review modal offers "Test it" for. */
export const TESTABLE_TYPES: ReadonlySet<string> = new Set(['skill']);

/**
 * First prompt of a skill-test session (pure — unit-tested).
 * With a user prompt:   `use the skill <path> in order to:\n<prompt>`
 * Without (or blank):   `run the skill <path>`
 */
export function buildSkillTestPrompt(path: string, userPrompt?: string | null): string {
  const trimmed = (userPrompt ?? '').trim();
  if (!trimmed) return `run the skill ${path}`;
  return `use the skill ${path} in order to:\n${trimmed}`;
}
